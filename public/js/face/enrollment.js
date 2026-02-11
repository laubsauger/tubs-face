import { STATE } from '../state.js';
import { logChat } from '../chat-log.js';
import { cosineSimilarity } from './math.js';
import { loadFaceLibrary } from './library.js';
import { getWorker, isWorkerReady, setWorkerBusy, scheduleNextCapture, getVideo, getCaptureCanvas } from './detection.js';

export async function enrollFace() {
    if (!STATE.cameraActive || !isWorkerReady()) {
        logChat('sys', 'Camera must be active to enroll a face');
        return;
    }

    const defaultName = STATE.personsPresent.length > 0 ? STATE.personsPresent[0] : '';
    const promptMsg = defaultName
        ? `Adding samples to "${defaultName}" (or enter a different name):`
        : 'Enter name for this face (multiple samples will be captured):';
    const name = prompt(promptMsg, defaultName);
    if (!name || !name.trim()) return;
    const trimmedName = name.trim();

    logChat('sys', `Enrolling "${trimmedName}" — capturing 5 samples over ~4s...`);

    const video = getVideo();
    const captureCanvas = getCaptureCanvas();
    const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
    const worker = getWorker();

    const samples = []; // { embedding, thumbnail }
    const SAMPLES = 5;
    const SAMPLE_DELAY = 800;
    const THUMB_SIZE = 80;
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_SIZE;
    thumbCanvas.height = THUMB_SIZE;
    const thumbCtx = thumbCanvas.getContext('2d');

    for (let i = 0; i < SAMPLES; i++) {
        if (i > 0) {
            await new Promise(r => setTimeout(r, SAMPLE_DELAY));
        }

        logChat('sys', `  Sample ${i + 1}/${SAMPLES}...`);

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) continue;

        const scale = Math.min(1, 640 / vw);
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);

        captureCanvas.width = w;
        captureCanvas.height = h;
        captureCtx.drawImage(video, 0, 0, w, h);

        const imageData = captureCtx.getImageData(0, 0, w, h);
        const buffer = imageData.data.buffer.slice(0);

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
            const embedding = faceResult.embedding;
            let isDuplicate = false;
            for (const prev of samples) {
                if (cosineSimilarity(embedding, prev.embedding) > 0.95) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                // Crop face bounding box as thumbnail
                const [x1, y1, x2, y2] = faceResult.box;
                const pad = Math.max((x2 - x1), (y2 - y1)) * 0.15;
                const cx = Math.max(0, x1 - pad);
                const cy = Math.max(0, y1 - pad);
                const cw = Math.min(w - cx, (x2 - x1) + pad * 2);
                const ch = Math.min(h - cy, (y2 - y1) + pad * 2);
                thumbCtx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
                thumbCtx.drawImage(captureCanvas, cx, cy, cw, ch, 0, 0, THUMB_SIZE, THUMB_SIZE);
                const thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.7);

                samples.push({ embedding, thumbnail });
            }
        }
    }

    setWorkerBusy(false);

    if (samples.length === 0) {
        logChat('sys', `No valid face samples captured for "${trimmedName}"`);
        return;
    }

    logChat('sys', `Saving ${samples.length} distinct embedding(s) for "${trimmedName}"...`);

    let saved = 0;
    for (const sample of samples) {
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

    logChat('sys', `Enrolled "${trimmedName}" with ${saved} sample(s)`);
    await loadFaceLibrary();

    scheduleNextCapture();
}
