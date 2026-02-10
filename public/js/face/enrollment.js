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

    const embeddings = [];
    const SAMPLES = 5;
    const SAMPLE_DELAY = 800;

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

        const embedding = await new Promise((resolve) => {
            const handler = (e) => {
                if (e.data.type === 'faces') {
                    worker.removeEventListener('message', handler);
                    const faces = e.data.faces;
                    if (faces.length === 1 && faces[0].embedding) {
                        resolve(faces[0].embedding);
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

        if (embedding) {
            let isDuplicate = false;
            for (const prev of embeddings) {
                if (cosineSimilarity(embedding, prev) > 0.95) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                embeddings.push(embedding);
            }
        }
    }

    setWorkerBusy(false);

    if (embeddings.length === 0) {
        logChat('sys', `No valid face samples captured for "${trimmedName}"`);
        return;
    }

    logChat('sys', `Saving ${embeddings.length} distinct embedding(s) for "${trimmedName}"...`);

    let saved = 0;
    for (const emb of embeddings) {
        try {
            const res = await fetch('/faces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmedName, embedding: emb })
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
