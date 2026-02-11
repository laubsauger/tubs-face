import { STATE } from '../state.js';
import { logChat } from '../chat-log.js';
import { handleFaceResults } from './results.js';
import { isDebugVisible, renderDebugFrame } from './debug.js';

// Config
const MIN_INTERVAL = 800;
const MAX_INTERVAL = 5000;
const IDLE_INTERVAL = 3000;
const IDLE_AFTER = 10000;
const INFERENCE_MULTIPLIER = 1.5;
let manualInterval = 0;

let worker = null;
let workerReady = false;
let captureTimeout = null;
let workerBusy = false;
let lastInferenceMs = 500;
let currentInterval = 1500;
let lastFaceSeen = 0;
let lastNoFaceTime = 0;

// DOM refs
const video = document.getElementById('camera-feed');
const statusEl = document.getElementById('camera-status');

// Offscreen canvas for frame capture
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

export function getWorker() { return worker; }
export function isWorkerReady() { return workerReady; }
export function isWorkerBusy() { return workerBusy; }
export function setWorkerBusy(v) { workerBusy = v; }
export function getLastFaceSeen() { return lastFaceSeen; }
export function setLastFaceSeen(v) { lastFaceSeen = v; }
export function getLastNoFaceTime() { return lastNoFaceTime; }
export function setLastNoFaceTime(v) { lastNoFaceTime = v; }
export function getCurrentInterval() { return currentInterval; }
export function getCaptureCanvas() { return captureCanvas; }
export function getVideo() { return video; }

export function setLastInferenceMs(v) { lastInferenceMs = v; }

export function initDelaySlider() {
    const delaySlider = document.getElementById('detect-delay');
    const delayVal = document.getElementById('detect-delay-val');

    delaySlider.addEventListener('input', () => {
        const v = parseInt(delaySlider.value, 10);
        manualInterval = v;
        delayVal.textContent = v === 0 ? 'auto' : (v / 1000).toFixed(1) + 's';
    });
}

function computeInterval() {
    if (manualInterval > 0) return manualInterval;

    let interval = Math.max(MIN_INTERVAL, lastInferenceMs * INFERENCE_MULTIPLIER);

    const timeSinceLastFace = Date.now() - lastFaceSeen;
    if (lastFaceSeen > 0 && timeSinceLastFace > IDLE_AFTER) {
        interval = Math.max(interval, IDLE_INTERVAL);
    }

    return Math.min(interval, MAX_INTERVAL);
}

export function scheduleNextCapture() {
    if (!STATE.cameraActive || !workerReady) return;
    clearTimeout(captureTimeout);
    currentInterval = computeInterval();
    captureTimeout = setTimeout(captureFrame, currentInterval);
}

export function clearCapture() {
    clearTimeout(captureTimeout);
    captureTimeout = null;
}

function captureFrame() {
    if (!video.srcObject || video.readyState < 2 || workerBusy || !workerReady) {
        scheduleNextCapture();
        return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
        scheduleNextCapture();
        return;
    }

    const scale = Math.min(1, 640 / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);

    if (captureCanvas.width !== w || captureCanvas.height !== h) {
        captureCanvas.width = w;
        captureCanvas.height = h;
    }
    captureCtx.drawImage(video, 0, 0, w, h);

    const imageData = captureCtx.getImageData(0, 0, w, h);

    if (isDebugVisible()) {
        renderDebugFrame(captureCanvas, w, h);
    }

    const buffer = imageData.data.buffer;
    workerBusy = true;
    worker.postMessage({
        type: 'detect',
        imageBuffer: buffer,
        width: w,
        height: h
    }, [buffer]);
}

export function initWorker() {
    worker = new Worker('js/face-worker.js');
    statusEl.textContent = 'Loading models...';

    worker.onmessage = (e) => {
        const msg = e.data;

        switch (msg.type) {
            case 'ready':
                workerReady = true;
                STATE.faceWorkerReady = true;
                statusEl.textContent = 'Ready';
                logChat('sys', 'Face detection ready');
                scheduleNextCapture();
                break;

            case 'progress':
                statusEl.textContent = msg.detail;
                logChat('sys', `[Face] ${msg.stage}: ${msg.detail}`);
                break;

            case 'faces':
                workerBusy = false;
                handleFaceResults(msg.faces, msg.inferenceMs);
                scheduleNextCapture();
                break;

            case 'error':
                workerBusy = false;
                console.error('[FaceWorker]', msg.message);
                statusEl.textContent = 'Error';
                scheduleNextCapture();
                break;
        }
    };

    worker.onerror = (err) => {
        console.error('[FaceWorker] Error:', err);
        statusEl.textContent = 'Worker error';
    };

    worker.postMessage({ type: 'init' });
}
