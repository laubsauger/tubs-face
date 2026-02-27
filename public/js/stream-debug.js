import { $ } from './dom.js';

const STORAGE_KEY = 'tubs.streamDebugEnabled';
const MAX_LINES = 140;

const counters = {
    llmDeltas: 0,
    llmChars: 0,
    sentences: 0,
    ttsSentences: 0,
    ttsChars: 0,
    audioChunksIn: 0,
    audioBytesIn: 0,
    audioChunksPlayed: 0,
    audioSecondsPlayed: 0,
};

let currentTurnId = null;
let initialized = false;
let enabled = true;

function safeText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
}

function formatTime(ts = Date.now()) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
}

function setStoredEnabled(value) {
    try {
        localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
        // ignore storage errors
    }
}

function getStoredEnabled() {
    try {
        return localStorage.getItem(STORAGE_KEY) !== '0';
    } catch {
        return true;
    }
}

function setEnabled(next) {
    enabled = Boolean(next);
    setStoredEnabled(enabled);
    const root = document.getElementById('stream-debug-root');
    if (root) {
        root.style.display = enabled ? '' : 'none';
    }
    const toggle = document.getElementById('stream-debug-enabled');
    if (toggle) {
        toggle.checked = enabled;
    }
}

function trimLog(log) {
    while (log.childElementCount > MAX_LINES) {
        log.removeChild(log.firstChild);
    }
}

function updateCounterUi() {
    safeText('stat-stream-turn', currentTurnId ? String(currentTurnId).slice(0, 8) : '—');
    safeText('stat-stream-llm', `${counters.llmDeltas}/${counters.llmChars}`);
    safeText('stat-stream-sentences', String(counters.sentences));
    safeText('stat-stream-tts-out', `${counters.ttsSentences}/${counters.ttsChars}`);
    safeText('stat-stream-audio-in', `${counters.audioChunksIn}/${Math.round(counters.audioBytesIn / 1024)}KB`);
    safeText('stat-stream-audio-play', `${counters.audioChunksPlayed}/${counters.audioSecondsPlayed.toFixed(2)}s`);
}

function formatPayload(payload) {
    const parts = [];
    if (payload.deltaChars != null) parts.push(`deltaChars=${payload.deltaChars}`);
    if (payload.bufferChars != null) parts.push(`bufferChars=${payload.bufferChars}`);
    if (payload.chunkIndex != null) parts.push(`chunkIndex=${payload.chunkIndex}`);
    if (payload.sentenceCount != null) parts.push(`sentenceCount=${payload.sentenceCount}`);
    if (payload.textChars != null) parts.push(`textChars=${payload.textChars}`);
    if (payload.pendingTtsSentences != null) parts.push(`pendingTts=${payload.pendingTtsSentences}`);
    if (payload.audioBytes != null) parts.push(`audioBytes=${payload.audioBytes}`);
    if (payload.audioDurationSec != null) parts.push(`audioSec=${Number(payload.audioDurationSec).toFixed(3)}`);
    if (payload.reason) parts.push(`reason=${payload.reason}`);
    if (payload.error) parts.push(`error=${payload.error}`);
    if (!parts.length) return '';
    return ` ${parts.join(' ')}`;
}

function appendLog(stage, payload = {}) {
    if (!enabled) return;
    const log = document.getElementById('stream-debug-log');
    if (!log) return;

    const row = document.createElement('div');
    row.className = 'stream-debug-line';

    const ts = document.createElement('span');
    ts.className = 'stream-debug-ts';
    ts.textContent = formatTime(payload.ts || Date.now());

    const text = document.createElement('span');
    text.className = 'stream-debug-msg';
    text.textContent = `${stage}${formatPayload(payload)}`;

    row.appendChild(ts);
    row.appendChild(text);
    log.appendChild(row);
    trimLog(log);
    log.scrollTop = log.scrollHeight;
}

function resetCounters(turnId = null) {
    currentTurnId = turnId || null;
    counters.llmDeltas = 0;
    counters.llmChars = 0;
    counters.sentences = 0;
    counters.ttsSentences = 0;
    counters.ttsChars = 0;
    counters.audioChunksIn = 0;
    counters.audioBytesIn = 0;
    counters.audioChunksPlayed = 0;
    counters.audioSecondsPlayed = 0;
    updateCounterUi();
}

function applyCounters(stage, payload = {}) {
    switch (stage) {
        case 'llm_delta':
            counters.llmDeltas += 1;
            counters.llmChars += Number(payload.deltaChars) || 0;
            break;
        case 'sentence_ready':
            counters.sentences += 1;
            break;
        case 'tts_sentence_sent':
            counters.ttsSentences += 1;
            counters.ttsChars += Number(payload.textChars) || 0;
            break;
        case 'tts_audio_chunk_in':
            counters.audioChunksIn += 1;
            counters.audioBytesIn += Number(payload.audioBytes) || 0;
            break;
        case 'audio_chunk_played':
            counters.audioChunksPlayed += 1;
            counters.audioSecondsPlayed += Number(payload.audioDurationSec) || 0;
            break;
        default:
            break;
    }
}

export function initStreamDebugUi() {
    if (initialized) return;
    initialized = true;

    enabled = getStoredEnabled();

    const toggle = document.getElementById('stream-debug-enabled');
    if (toggle) {
        toggle.checked = enabled;
        toggle.addEventListener('change', () => {
            setEnabled(toggle.checked);
        });
    }

    const clearBtn = document.getElementById('stream-debug-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            const log = document.getElementById('stream-debug-log');
            if (log) log.innerHTML = '';
        });
    }

    setEnabled(enabled);
    resetCounters(null);
}

export function resetStreamDebug(turnId = null) {
    resetCounters(turnId);
    const log = document.getElementById('stream-debug-log');
    if (log) log.innerHTML = '';
    appendLog('turn_start', { turnId });
}

export function pushStreamDebugEvent(stage, payload = {}) {
    if (!stage) return;
    if (payload.turnId && payload.turnId !== currentTurnId) {
        currentTurnId = payload.turnId;
    }
    applyCounters(stage, payload);
    updateCounterUi();
    appendLog(stage, payload);
}
