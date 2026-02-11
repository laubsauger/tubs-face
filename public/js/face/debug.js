import { getFaceLibrary, loadFaceLibrary } from './library.js';
import { getCurrentInterval } from './detection.js';

let debugVisible = false;
let lastDebugFaces = [];

const debugPanel = document.getElementById('face-debug');
const debugCanvas = document.getElementById('face-debug-canvas');
const debugDetections = document.getElementById('face-debug-detections');
const debugClose = document.getElementById('face-debug-close');
const libraryList = document.getElementById('face-library-list');
const libraryRefresh = document.getElementById('face-library-refresh');

debugClose.addEventListener('click', () => {
    toggleDebug();
});

libraryRefresh.addEventListener('click', async () => {
    await loadFaceLibrary();
    renderLibrary();
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
    if (debugVisible) {
        if (lastDebugFaces.length > 0) renderDebugDetections(lastDebugFaces, 0);
        renderLibrary();
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

    document.getElementById('dbg-interval').textContent = `${Math.round(getCurrentInterval())}ms`;
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

// ── Face Library Manager ──

function renderLibrary() {
    const lib = getFaceLibrary();
    if (!lib.length) {
        libraryList.innerHTML = '<div style="color:var(--text-dim);padding:4px 0;font-size:11px;">Library empty</div>';
        return;
    }

    // Group by name
    const byName = {};
    for (const entry of lib) {
        if (!byName[entry.name]) byName[entry.name] = [];
        byName[entry.name].push(entry);
    }

    libraryList.innerHTML = '';
    for (const [name, entries] of Object.entries(byName).sort((a, b) => a[0].localeCompare(b[0]))) {
        const card = document.createElement('div');
        card.className = 'lib-person';

        let html = `<div class="lib-person-header">`;
        html += `<span class="lib-person-name">${escapeDebugHTML(name)}</span>`;
        html += `<div class="lib-person-actions">`;
        html += `<span class="lib-person-count">${entries.length} emb</span>`;
        html += `<button class="lib-btn danger" data-delete-name="${escapeDebugHTML(name)}">Delete All</button>`;
        html += `</div></div>`;

        html += `<div class="lib-embeddings">`;
        for (const e of entries) {
            const date = e.createdAt ? new Date(e.createdAt).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
            }) : '—';
            html += `<div class="lib-embedding-row">`;
            if (e.thumbnail) {
                html += `<img class="lib-emb-thumb" src="${e.thumbnail}" alt="" />`;
            } else {
                html += `<span class="lib-emb-thumb lib-emb-thumb-none">?</span>`;
            }
            html += `<span class="lib-emb-date">${date}</span>`;
            html += `<button class="lib-btn danger" data-delete-id="${e.id}">✕</button>`;
            html += `</div>`;
        }
        html += `</div>`;

        card.innerHTML = html;
        libraryList.appendChild(card);
    }

    // Wire up delete buttons
    libraryList.querySelectorAll('[data-delete-id]').forEach(btn => {
        btn.addEventListener('click', () => deleteEmbedding(btn.dataset.deleteId));
    });
    libraryList.querySelectorAll('[data-delete-name]').forEach(btn => {
        btn.addEventListener('click', () => deleteAllForName(btn.dataset.deleteName));
    });
}

async function deleteEmbedding(id) {
    try {
        const res = await fetch(`/faces?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadFaceLibrary();
        renderLibrary();
    } catch (err) {
        console.error('[Faces] Delete failed:', err);
    }
}

async function deleteAllForName(name) {
    const lib = getFaceLibrary();
    const ids = lib.filter(e => e.name === name).map(e => e.id);
    if (!ids.length) return;
    try {
        for (const id of ids) {
            await fetch(`/faces?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        }
        await loadFaceLibrary();
        renderLibrary();
    } catch (err) {
        console.error('[Faces] Bulk delete failed:', err);
    }
}
