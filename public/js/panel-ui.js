import { STATE } from './state.js';
import { $ } from './dom.js';

function clearTopLeftInlinePanelLayout() {
    const stack = document.getElementById('stack-tl');
    const systemPanel = document.getElementById('panel-tl');
    const inputPanel = document.getElementById('panel-input') || document.getElementById('panel-tr');

    if (stack) {
        stack.style.position = '';
        stack.style.top = '';
        stack.style.left = '';
        stack.style.width = '';
        stack.style.height = '';
    }

    [systemPanel, inputPanel].forEach((panel) => {
        if (!panel) return;
        panel.style.position = '';
        panel.style.top = '';
        panel.style.left = '';
        panel.style.right = '';
        panel.style.width = '';
    });
}

export function initPanelCollapse() {
    clearTopLeftInlinePanelLayout();

    document.querySelectorAll('.panel-title').forEach(title => {
        title.addEventListener('click', () => {
            const panel = title.parentElement;
            panel.classList.toggle('collapsed');
        });
    });
}

export function initPanelResize() {
    const panel = document.getElementById('panel-bl');
    const handle = document.getElementById('panel-bl-resize');
    if (!panel || !handle) return;

    let startX, startW;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        panel.classList.add('resizing');
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onUp);
    });

    function onDrag(e) {
        const delta = e.clientX - startX;
        const newW = Math.max(200, Math.min(800, startW + delta));
        panel.style.width = newW + 'px';
        panel.style.maxWidth = newW + 'px';
    }

    function onUp() {
        panel.classList.remove('resizing');
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', onUp);
    }
}

export function startUptimeTimer() {
    setInterval(() => {
        if (STATE.sleeping) return;
        const elapsed = Math.floor((Date.now() - STATE.wakeTime) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        $('#stat-uptime').textContent = `${h}:${m}:${s}`;
    }, 1000);
}
