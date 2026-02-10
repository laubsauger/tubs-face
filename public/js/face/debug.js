import { getFaceLibrary } from './library.js';

let debugVisible = false;
let lastDebugFaces = [];

const debugPanel = document.getElementById('face-debug');
const debugCanvas = document.getElementById('face-debug-canvas');
const debugDetections = document.getElementById('face-debug-detections');
const debugClose = document.getElementById('face-debug-close');

debugClose.addEventListener('click', () => {
    toggleDebug();
});

export function isDebugVisible() {
    return debugVisible;
}

export function getLastDebugFaces() {
    return lastDebugFaces;
}

export function setLastDebugFaces(faces) {
    lastDebugFaces = faces;
}

export function toggleDebug() {
    debugVisible = !debugVisible;
    debugPanel.classList.toggle('hidden', !debugVisible);
    if (debugVisible && lastDebugFaces.length > 0) {
        renderDebugDetections(lastDebugFaces, 0);
    }
}

export function renderDebugFrame(captureCanvas, w, h) {
    debugCanvas.width = w;
    debugCanvas.height = h;
    const ctx = debugCanvas.getContext('2d');
    ctx.drawImage(captureCanvas, 0, 0);

    for (const f of lastDebugFaces) {
        const [x1, y1, x2, y2] = f.box;
        ctx.lineWidth = 2;
        ctx.strokeStyle = f.matchName ? '#00e5a0' : '#ffa726';
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

        if (f.matchName) {
            ctx.font = '12px Outfit, sans-serif';
            ctx.fillStyle = 'rgba(0, 229, 160, 0.8)';
            ctx.fillText(`${f.matchName} ${(f.matchScore * 100).toFixed(0)}%`, x1 + 2, y1 - 4);
        }
    }
}

export function renderDebugDetections(faces, inferenceMs) {
    const faceLibrary = getFaceLibrary();

    document.getElementById('dbg-interval').textContent = `—`;
    document.getElementById('dbg-inference').textContent = `${inferenceMs}ms`;
    document.getElementById('dbg-faces').textContent = faces.length;
    const names = [...new Set(faceLibrary.map(f => f.name))];
    document.getElementById('dbg-library').textContent = `${faceLibrary.length} emb / ${names.length} ppl`;

    debugDetections.innerHTML = '';

    if (faces.length === 0) {
        debugDetections.innerHTML = '<div style="color:var(--text-dim);padding:4px 0;">No faces detected</div>';
        return;
    }

    for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        const entry = document.createElement('div');
        entry.className = 'debug-face-entry';

        let header = `<div class="debug-face-header">`;
        header += `<span class="face-idx">Face #${i + 1}</span>`;
        header += `<span class="face-conf">det: ${(f.confidence * 100).toFixed(1)}%</span>`;
        header += `</div>`;

        let candidatesHtml = '<div class="debug-face-candidates">';
        if (f.candidates.length === 0) {
            candidatesHtml += '<div style="color:var(--text-dim)">No library entries</div>';
        } else {
            for (const c of f.candidates) {
                const pct = (c.score * 100).toFixed(1);
                const cls = c.isMatch ? 'match' : (c.score > 0.3 ? '' : 'below');
                candidatesHtml += `<div class="debug-candidate ${cls}">`;
                candidatesHtml += `<span class="cand-name">${escapeDebugHTML(c.name)}</span>`;
                candidatesHtml += `<span class="cand-score">${pct}%</span>`;
                candidatesHtml += `</div>`;
            }
        }
        candidatesHtml += '</div>';

        entry.innerHTML = header + candidatesHtml;
        debugDetections.appendChild(entry);
    }
}

function escapeDebugHTML(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
