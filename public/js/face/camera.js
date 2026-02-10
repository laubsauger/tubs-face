import { STATE } from '../state.js';
import { logChat } from '../chat-log.js';
import { loadFaceLibrary } from './library.js';
import { initWorker, isWorkerReady, scheduleNextCapture, clearCapture, getVideo } from './detection.js';

const pip = document.getElementById('camera-pip');
const pipHeader = document.getElementById('camera-pip-header');
const video = getVideo();
const overlay = document.getElementById('camera-overlay');
const toggle = document.getElementById('camera-toggle');
const badge = document.getElementById('presence-badge');
const delayRow = document.getElementById('detect-delay-row');

export function initCameraListeners() {
    toggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            startCamera();
        } else {
            stopCamera();
        }
    });

    pipHeader.addEventListener('click', () => {
        pip.classList.toggle('collapsed');
    });
}

export async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        video.srcObject = stream;

        video.onloadedmetadata = () => {
            overlay.width = video.videoWidth;
            overlay.height = video.videoHeight;
        };

        pip.classList.remove('hidden');
        delayRow.style.display = '';
        STATE.cameraActive = true;
        logChat('sys', 'Camera active');

        await loadFaceLibrary();

        if (!isWorkerReady()) {
            initWorker();
        } else {
            scheduleNextCapture();
        }
    } catch (err) {
        console.error('[Camera] Init failed:', err);
        logChat('sys', `Camera error: ${err.message}`);
        toggle.checked = false;
        STATE.cameraActive = false;
    }
}

export function stopCamera() {
    clearCapture();

    if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }

    pip.classList.add('hidden');
    delayRow.style.display = 'none';
    STATE.cameraActive = false;
    STATE.facesDetected = 0;
    STATE.personsPresent = [];
    STATE.presenceDetected = false;
    badge.classList.remove('visible');

    const ctx = overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);

    logChat('sys', 'Camera off');
}
