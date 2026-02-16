import { liveUserTranscriptEl } from './dom.js';

let liveUserTranscriptText = '';

export function showLiveUserTranscript(text, { draft = true } = {}) {
    if (!liveUserTranscriptEl) return;
    const normalized = String(text || '').trim();
    if (!normalized) {
        clearLiveUserTranscript();
        return;
    }
    liveUserTranscriptText = normalized;
    liveUserTranscriptEl.textContent = normalized;
    liveUserTranscriptEl.classList.add('visible');
    liveUserTranscriptEl.classList.toggle('draft', draft);
}

export function clearLiveUserTranscript() {
    liveUserTranscriptText = '';
    if (!liveUserTranscriptEl) return;
    liveUserTranscriptEl.textContent = '';
    liveUserTranscriptEl.classList.remove('visible', 'draft');
}

export function getLiveUserTranscriptText() {
    return liveUserTranscriptText;
}
