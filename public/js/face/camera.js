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

const PIP_MIN_W = 200;
const PIP_MIN_H = 140;
const RESIZE_EDGES = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];

export function initCameraListeners() {
    toggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            startCamera();
        } else {
            stopCamera();
        }
    });

    // In camera.js - Inside initCameraListeners()
    pipHeader.addEventListener('click', () => {
        pip.classList.toggle('collapsed');
        // Reset manual resize when collapsing/expanding
        pip.style.width = '';
        pip.style.height = '';
        pip.style.right = '';
        pip.style.bottom = '';
    });

    initPipResize();
}

function initPipResize() {
    for (const edge of RESIZE_EDGES) {
        const handle = document.createElement('div');
        handle.className = `pip-resize-handle pip-resize-${edge}`;
        handle.dataset.edge = edge;
        pip.appendChild(handle);
    }

    pip.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('.pip-resize-handle');
        if (!handle) return;
        e.preventDefault();

        const edge = handle.dataset.edge;
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = pip.offsetWidth;
        const startH = pip.offsetHeight;
        const cs = getComputedStyle(pip);
        const startRight = parseFloat(cs.right);
        const startBottom = parseFloat(cs.bottom);

        function onMove(ev) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            let w = startW, h = startH, r = startRight, b = startBottom;

            if (edge.includes('w')) {
                // Left edge: right stays anchored, width grows leftward
                w = Math.max(PIP_MIN_W, startW - dx);
            }
            if (edge.includes('e')) {
                // Right edge: left stays anchored → right + width both change
                const newW = Math.max(PIP_MIN_W, startW + dx);
                r = Math.max(0, startRight - (newW - startW));
                w = newW;
            }
            if (edge.includes('n')) {
                // Top edge: bottom stays anchored, height grows upward
                h = Math.max(PIP_MIN_H, startH - dy);
            }
            if (edge.includes('s')) {
                // Bottom edge: top stays anchored → bottom + height both change
                const newH = Math.max(PIP_MIN_H, startH + dy);
                b = Math.max(0, startBottom - (newH - startH));
                h = newH;
            }

            pip.style.width = w + 'px';
            pip.style.height = h + 'px';
            pip.style.right = r + 'px';
            pip.style.bottom = b + 'px';
        }

        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
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
