import { STATE } from './state.js';
import { $ } from './dom.js';
import { logChat } from './chat-log.js';
import { enterSleep, exitSleep } from './sleep.js';
import { startRecording, stopRecording } from './audio-input.js';
import { getWs } from './websocket.js';
import { faceManager } from './face/index.js';
import { setFullscreenEnabled } from './fullscreen.js';
import { captureFrameBase64 } from './vision-capture.js';

let keyInputBuffer = '';

const SHORTCUT_KEYS = new Set(['z', 'Z', 's', 'S', 'c', 'C', 'f', 'F', 'd', 'D', 'x', 'X']);

export function initKeyboard() {
    document.addEventListener('keydown', (e) => {
        const inInput = document.activeElement && document.activeElement.tagName === 'INPUT';

        if (e.code === 'Space' && !e.repeat && document.activeElement === document.body) {
            e.preventDefault();
            if (STATE.sleeping) {
                exitSleep();
                return;
            }
            startRecording();
            return;
        }

        if (e.code === 'Escape') {
            if (STATE.sleeping) exitSleep();
            else enterSleep();
            return;
        }

        if (e.code === 'Enter' && keyInputBuffer.trim()) {
            e.preventDefault();
            const text = keyInputBuffer.trim();
            keyInputBuffer = '';

            if (STATE.sleeping) exitSleep();

            if (/go to sleep/i.test(text)) {
                enterSleep();
                return;
            }

            const ws = getWs();
            if (ws && ws.readyState === 1) {
                const frame = captureFrameBase64();
                const msg = { type: 'incoming', text };
                if (frame) msg.frame = frame;
                ws.send(JSON.stringify(msg));
                logChat('out', text);
                STATE.totalMessages++;
                $('#stat-input-src').textContent = 'Keyboard';
                STATE.lastActivity = Date.now();
            }
            return;
        }

        if (!inInput && SHORTCUT_KEYS.has(e.key)) {
            if (e.key === 'z' || e.key === 'Z') {
                document.getElementById('grid').classList.toggle('hidden-ui');
            }
            if (e.key === 's' || e.key === 'S') {
                if (STATE.sleeping) exitSleep();
                else enterSleep();
            }
            if (e.key === 'c' || e.key === 'C') {
                const toggle = document.getElementById('camera-toggle');
                if (toggle) {
                    toggle.checked = !toggle.checked;
                    toggle.dispatchEvent(new Event('change'));
                }
            }
            if (e.key === 'f' || e.key === 'F') {
                faceManager.enrollFace();
            }
            if (e.key === 'd' || e.key === 'D') {
                faceManager.toggleDebug();
            }
            if (e.key === 'x' || e.key === 'X') {
                setFullscreenEnabled(!(document.fullscreenElement || document.webkitFullscreenElement)).catch(() => { });
            }
            return;
        }

        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            keyInputBuffer += e.key;
        }
        if (e.code === 'Backspace') {
            keyInputBuffer = keyInputBuffer.slice(0, -1);
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && STATE.recording) {
            stopRecording();
        }
    });

    document.addEventListener('click', () => {
        if (STATE.sleeping) exitSleep();
    });
}
