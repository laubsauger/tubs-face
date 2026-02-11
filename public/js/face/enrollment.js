import { STATE } from '../state.js';
import { logChat } from '../chat-log.js';
import { cosineSimilarity } from './math.js';
import { loadFaceLibrary } from './library.js';
import { getWorker, isWorkerReady, setWorkerBusy, scheduleNextCapture, getVideo, getCaptureCanvas } from './detection.js';

const CAPTURE_MAX_WIDTH = 960;
const THUMB_SIZE = 200;
const DUPE_SIMILARITY_THRESH = 0.98;
const AUTO_SAVE_SECONDS = 10;
const SAMPLE_DELAY = 1400;

const INSTRUCTIONS = [
    { text: 'Look at Camera', icon: '😐' },
    { text: 'Still looking at Camera', icon: '😐' },
    { text: 'Turn Slightly Left', icon: '⬅️' },
    { text: 'Turn Slightly Right', icon: '➡️' },
    { text: 'Tilt Head Up', icon: '⬆️' },
    { text: 'Tilt Head Down', icon: '⬇️' },
    { text: 'Expression: Smile', icon: '🙂' },
    { text: 'Back to Neutral', icon: '😐' }
];

// UI Refs
const overlay = document.getElementById('enroll-overlay');
const statusEl = document.getElementById('enroll-status');
const instructionEl = document.getElementById('enroll-instruction');
const stripEl = document.getElementById('enroll-strip');
const actionsEl = document.getElementById('enroll-actions');
const btnSave = document.getElementById('enroll-save');
const btnCancel = document.getElementById('enroll-cancel');
const pip = document.getElementById('camera-pip');

// Sound Generator
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playShutter() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

export async function enrollFace() {
    if (!STATE.cameraActive || !isWorkerReady()) {
        logChat('sys', 'Camera must be active to enroll a face');
        return;
    }

    const defaultName = STATE.personsPresent.length > 0 ? STATE.personsPresent[0] : '';
    const name = prompt('Enter name for face:', defaultName);
    if (!name || !name.trim()) return;
    const trimmedName = name.trim();

    // Mode Selection
    const isFullEnrollment = confirm(`Enrollment Mode:\nOK = Full Guided Enrollment (8 samples)\nCancel = Single Capture (1 sample)`);
    const targetSamples = isFullEnrollment ? 8 : 1;
    const instructions = isFullEnrollment ? INSTRUCTIONS : [{ text: 'Look at Camera', icon: '📸' }];

    try {
        // Show Overlay
        if (pip.classList.contains('hidden')) pip.classList.remove('hidden');
        pip.classList.add('enroll-mode');
        overlay.classList.remove('hidden');
        actionsEl.classList.add('hidden');
        stripEl.innerHTML = '';

        logChat('sys', `Enrolling "${trimmedName}" (${targetSamples} samples)...`);

        const video = getVideo();
        const captureCanvas = getCaptureCanvas();
        const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
        const worker = getWorker();

        const samples = [];
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = THUMB_SIZE;
        thumbCanvas.height = THUMB_SIZE;
        const thumbCtx = thumbCanvas.getContext('2d');

        // Capture Loop
        for (let i = 0; i < targetSamples; i++) {
            const instr = instructions[i] || { text: 'Look at Camera', icon: '📸' };

            // Countdown 3..2..1..
            for (let c = 3; c > 0; c--) {
                if (instructionEl) {
                    instructionEl.innerHTML = `${instr.text}<br><span style="font-size:48px;color:#fff">${c}</span>`;
                    instructionEl.setAttribute('data-icon', instr.icon);
                }
                statusEl.textContent = `Sample ${i + 1}/${targetSamples}`;
                await new Promise(r => setTimeout(r, 800));
            }
            if (instructionEl) {
                instructionEl.innerHTML = `${instr.text}<br><span style="font-size:48px;color:#00e5a0">SNAP!</span>`;
            }
            playShutter();

            // Attempt Capture (with retries)
            let capturedFace = null;
            let attempts = 0;
            const MAX_ATTEMPTS = 5;
            let w = 0;
            let h = 0;

            while (!capturedFace && attempts < MAX_ATTEMPTS) {
                const vw = video.videoWidth;
                const vh = video.videoHeight;
                if (!vw || !vh) { await new Promise(r => setTimeout(r, 200)); continue; }

                const scale = Math.min(1, CAPTURE_MAX_WIDTH / vw);
                w = Math.round(vw * scale);
                h = Math.round(vh * scale);

                captureCanvas.width = w;
                captureCanvas.height = h;
                captureCtx.drawImage(video, 0, 0, w, h);

                const imageData = captureCtx.getImageData(0, 0, w, h);
                const buffer = imageData.data.buffer.slice(0);

                // Detect
                const faceResult = await new Promise((resolve) => {
                    const handler = (e) => {
                        if (e.data.type === 'faces') {
                            worker.removeEventListener('message', handler);
                            const faces = e.data.faces;
                            if (faces.length === 1 && faces[0].embedding) {
                                resolve(faces[0]);
                            } else {
                                resolve(null);
                            }
                        }
                    };
                    worker.addEventListener('message', handler);
                    worker.postMessage({
                        type: 'detect',
                        imageBuffer: buffer,
                        width: w,
                        height: h
                    }, [buffer]);
                });

                if (faceResult) {
                    capturedFace = faceResult;
                    break;
                }
                attempts++;
                await new Promise(r => setTimeout(r, 200));
            }

            if (capturedFace) {
                const embedding = capturedFace.embedding;
                let isDuplicate = false;
                for (const prev of samples) {
                    if (cosineSimilarity(embedding, prev.embedding) > DUPE_SIMILARITY_THRESH) {
                        isDuplicate = true;
                        break;
                    }
                }

                if (isDuplicate) {
                    if (instructionEl) {
                        instructionEl.innerHTML = `${instr.text}<br><span style="font-size:28px;color:#ffaa00">Duplicate - Discarded</span>`;
                    }
                    // No retry, just proceed and mark discarded
                }

                // Create Thumbnail
                const [x1, y1, x2, y2] = capturedFace.box;
                const pad = Math.max((x2 - x1), (y2 - y1)) * 0.15;
                const cx = Math.max(0, x1 - pad);
                const cy = Math.max(0, y1 - pad);
                const cw = Math.min(w - cx, (x2 - x1) + pad * 2);
                const ch = Math.min(h - cy, (y2 - y1) + pad * 2);
                thumbCtx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
                thumbCtx.drawImage(captureCanvas, cx, cy, cw, ch, 0, 0, THUMB_SIZE, THUMB_SIZE);
                const thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.7);

                const thumbWrap = document.createElement('div');
                thumbWrap.className = 'thumb-wrap';
                if (isDuplicate) {
                    thumbWrap.classList.add('duplicate', 'discarded');
                }

                const imgEl = document.createElement('img');
                imgEl.src = thumbnail;
                thumbWrap.appendChild(imgEl);

                // Toggle discard logic
                thumbWrap.onclick = () => {
                    const sample = samples.find(s => s.thumbnail === thumbnail);
                    if (sample) {
                        sample.discarded = !sample.discarded;
                        // For duplicates, we also toggle .duplicate class based on discard? 
                        // No, .duplicate is permanent flag. .discarded is state.
                        thumbWrap.classList.toggle('discarded', sample.discarded);
                        reset_auto_save();
                    }
                };

                stripEl.appendChild(thumbWrap);
                samples.push({ embedding, thumbnail, discarded: isDuplicate });

            } else {
                // Failed capture (no face) -> Retry
                if (instructionEl) {
                    instructionEl.innerHTML = `${instr.text}<br><span style="font-size:32px;color:#ff4d4d">Face Missed! Retrying...</span>`;
                }
                await new Promise(r => setTimeout(r, 1000));
                i--;
            }
        }

        setWorkerBusy(false);
        if (instructionEl) {
            instructionEl.textContent = '';
            instructionEl.setAttribute('data-icon', '');
        }

        if (samples.length === 0) {
            logChat('sys', `No valid face samples captured.`);
            return;
        }

        // Auto-Save Phase
        actionsEl.classList.remove('hidden');
        let autoSaveTimer = null;
        let secondsLeft = AUTO_SAVE_SECONDS;
        let intervalId = null;
        let resolverRef = null;

        btnSave.textContent = 'Save Now';
        btnCancel.textContent = 'Cancel';

        function updateStatus() {
            statusEl.innerHTML = `Auto-saving in <strong>${secondsLeft}s</strong>... (Click bad ones to discard)`;
        }

        function reset_auto_save() {
            if (resolverRef) {
                secondsLeft = AUTO_SAVE_SECONDS;
                updateStatus();
                clearTimeout(autoSaveTimer);
                clearInterval(intervalId);
                start_timer();
            }
        }

        function start_timer() {
            updateStatus();
            intervalId = setInterval(() => {
                secondsLeft--;
                updateStatus();
                if (secondsLeft <= 0) clearInterval(intervalId);
            }, 1000);

            autoSaveTimer = setTimeout(() => {
                if (resolverRef) resolverRef('save');
            }, AUTO_SAVE_SECONDS * 1000);
        }

        const userAction = await new Promise((resolve) => {
            resolverRef = resolve;
            start_timer();

            const onSave = () => { cleanup_listeners(); resolve('save'); };
            const onCancel = () => { cleanup_listeners(); resolve('cancel'); };

            function cleanup_listeners() {
                clearTimeout(autoSaveTimer);
                clearInterval(intervalId);
                btnSave.removeEventListener('click', onSave);
                btnCancel.removeEventListener('click', onCancel);
            }

            btnSave.addEventListener('click', onSave);
            btnCancel.addEventListener('click', onCancel);
        });

        if (userAction === 'cancel') {
            logChat('sys', 'Enrollment cancelled.');
            return;
        }

        // Save Phase
        const validSamples = samples.filter(s => !s.discarded);

        if (validSamples.length === 0) {
            logChat('sys', 'All samples discarded. Nothing saved.');
        } else {
            statusEl.textContent = 'Saving...';
            let saved = 0;
            for (const sample of validSamples) {
                try {
                    const res = await fetch('/faces', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: trimmedName,
                            embedding: sample.embedding,
                            thumbnail: sample.thumbnail,
                        })
                    });
                    const data = await res.json();
                    if (data.ok) saved++;
                } catch (err) {
                    console.error('[Enroll] Save error:', err);
                }
            }
            logChat('sys', `Enrolled "${trimmedName}" with ${saved} samples`);
            await loadFaceLibrary();
        }

    } catch (err) {
        console.error('[Enroll] Critical error:', err);
        logChat('sys', 'Enrollment failed due to an error.');
    } finally {
        overlay.classList.add('hidden');
        pip.classList.remove('enroll-mode');
        stripEl.innerHTML = '';
        statusEl.textContent = '';
        actionsEl.classList.add('hidden');
        scheduleNextCapture();
    }
}
