import { STATE } from '../state.js';
import { logChat } from '../chat-log.js';
import { cosineSimilarity } from './math.js';
import { loadFaceLibrary } from './library.js';
import { isWorkerReady, requestSharedFacesSnapshot, getVideo, getCaptureCanvas } from './detection.js';

const CAPTURE_MAX_WIDTH = 960;
const THUMB_SIZE = 200;
const DUPE_SIMILARITY_THRESH = 0.82;
const MAX_DUPE_RETRIES = 1;
const AUTO_SAVE_SECONDS = 10;
const SAMPLE_DELAY = 1400;

const INSTRUCTIONS = [
    { text: 'Look straight at the camera', icon: '😐', hint: 'Face forward, eyes on the lens' },
    { text: 'Now turn your head LEFT', icon: '⬅️', hint: 'Just slightly — like checking your shoulder' },
    { text: 'Turn your head RIGHT', icon: '➡️', hint: 'Mirror what you just did, other side' },
    { text: 'Tilt your head UP a bit', icon: '⬆️', hint: 'Like you\'re looking at a tall shelf' },
    { text: 'Tilt your head DOWN', icon: '⬇️', hint: 'Like reading your phone' },
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
let enrollmentInProgress = false;

function playTone(freq, endFreq, duration, type = 'square', vol = 0.1) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(endFreq, audioCtx.currentTime + duration);
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    osc.start();
    osc.stop(audioCtx.currentTime + duration + 0.02);
}

function playShutter() { playTone(800, 1200, 0.05); }
function playCountdownTick() { playTone(440, 440, 0.04, 'sine', 0.06); }
function playNewPose() { playTone(600, 900, 0.12, 'sine', 0.12); }
function playSuccess() { playTone(800, 1600, 0.15, 'sine', 0.1); }
function playFail() { playTone(300, 200, 0.2, 'sawtooth', 0.08); }

export async function enrollFace() {
    if (enrollmentInProgress) {
        logChat('sys', 'Enrollment already in progress');
        return;
    }

    enrollmentInProgress = true;
    STATE.enrolling = true;

    try {
        if (!STATE.cameraActive || !isWorkerReady()) {
            logChat('sys', 'Camera must be active to enroll a face');
            return;
        }

        const defaultName = STATE.personsPresent.length > 0 ? STATE.personsPresent[0] : '';
        const name = prompt('Enter name for face:', defaultName);
        if (!name || !name.trim()) return;
        const trimmedName = name.trim();

        // Mode Selection
        const isFullEnrollment = confirm(`Enrollment Mode:\nOK = Full Guided Enrollment (5 poses)\nCancel = Single Capture (1 sample)`);
        const targetSamples = isFullEnrollment ? INSTRUCTIONS.length : 1;
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
            const samples = [];
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = THUMB_SIZE;
            thumbCanvas.height = THUMB_SIZE;
            const thumbCtx = thumbCanvas.getContext('2d');

            // Capture Loop
            let dupeRetries = 0;
            for (let i = 0; i < targetSamples; i++) {
            const instr = instructions[i] || { text: 'Look at Camera', icon: '📸', hint: '' };

            // New pose announcement — make it very obvious
            playNewPose();
            if (instructionEl) {
                instructionEl.setAttribute('data-icon', instr.icon);
                instructionEl.classList.add('new-pose');
                instructionEl.innerHTML = `<div class="enroll-text-wrap"><span class="enroll-main">${instr.text}</span>` +
                    (instr.hint ? `<span class="enroll-hint">${instr.hint}</span>` : '') + `</div>`;
            }
            statusEl.innerHTML = `<span class="enroll-progress">POSE ${i + 1} of ${targetSamples}</span>`;

            // Hold for a moment to let user read the instruction
            await new Promise(r => setTimeout(r, 1200));
            if (instructionEl) instructionEl.classList.remove('new-pose');

            // Countdown 3..2..1..
            for (let c = 3; c > 0; c--) {
                playCountdownTick();
                if (instructionEl) {
                    instructionEl.innerHTML = `<div class="enroll-text-wrap"><span class="enroll-main">${instr.text}</span>` +
                        `<span class="enroll-countdown">${c}</span></div>`;
                    instructionEl.setAttribute('data-icon', instr.icon);
                }
                await new Promise(r => setTimeout(r, 800));
            }
            if (instructionEl) {
                instructionEl.innerHTML = `<div class="enroll-text-wrap"><span class="enroll-snap">SNAP!</span></div>`;
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

                let faceResult = null;
                try {
                    const packet = await requestSharedFacesSnapshot(2400);
                    const faces = Array.isArray(packet?.faces) ? packet.faces : [];
                    if (faces.length === 1 && faces[0].embedding) {
                        faceResult = faces[0];
                    }
                } catch {
                    faceResult = null;
                }

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
                    dupeRetries = (dupeRetries || 0) + 1;
                    playFail();
                    if (dupeRetries <= MAX_DUPE_RETRIES) {
                        if (instructionEl) {
                            instructionEl.innerHTML = `<div class="enroll-text-wrap"><span class="enroll-warn">Too similar!</span><span class="enroll-hint">Move your head more — retrying this pose</span></div>`;
                        }
                        await new Promise(r => setTimeout(r, 1500));
                        i--; // retry same pose
                        continue;
                    }
                    // Exceeded retries — accept it but mark as discarded
                    if (instructionEl) {
                        instructionEl.innerHTML = `<div class="enroll-text-wrap"><span class="enroll-warn">Still similar — skipping</span><span class="enroll-hint">Moving on to next pose</span></div>`;
                    }
                    await new Promise(r => setTimeout(r, 800));
                } else {
                    dupeRetries = 0;
                    playSuccess();
                }

                // Create Thumbnail
                const [x1, y1, x2, y2] = capturedFace.box;
                const pad = Math.max((x2 - x1), (y2 - y1)) * 0.15;
                const cx = Math.max(0, x1 - pad);
                const cy = Math.max(0, y1 - pad);
                const cw = Math.min(w - cx, (x2 - x1) + pad * 2);
                const ch = Math.min(h - cy, (y2 - y1) + pad * 2);
                thumbCtx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
                thumbCtx.fillStyle = '#000';
                thumbCtx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
                // Fit face into square preserving aspect ratio
                const scale = Math.min(THUMB_SIZE / cw, THUMB_SIZE / ch);
                const dw = cw * scale;
                const dh = ch * scale;
                const dx = (THUMB_SIZE - dw) / 2;
                const dy = (THUMB_SIZE - dh) / 2;
                thumbCtx.drawImage(captureCanvas, cx, cy, cw, ch, dx, dy, dw, dh);
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
                playFail();
                if (instructionEl) {
                    instructionEl.innerHTML = `<div class="enroll-text-wrap"><span class="enroll-error">No face detected!</span><span class="enroll-hint">Make sure your face is visible and try again</span></div>`;
                }
                await new Promise(r => setTimeout(r, 1500));
                i--;
            }
        }

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
        }
    } finally {
        STATE.enrolling = false;
        enrollmentInProgress = false;
    }
}
