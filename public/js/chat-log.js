import { STATE } from './state.js';
import { $, chatLog } from './dom.js';

const MAX_MESSAGES = 300;
const TRIM_TO = 200;

let scrollRafPending = false;
function scheduleScroll() {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
        scrollRafPending = false;
        chatLog.scrollTop = chatLog.scrollHeight;
    });
}

export function escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function normalizeLogText(text) {
    // Strip non-printable control chars that can render unpredictably in HTML text nodes.
    const normalized = String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return normalized;
}

function isVisibleForVerbosity(type) {
    if (STATE.chatVerbosity === 'chat') return type !== 'sys';
    if (STATE.chatVerbosity === 'minimal') return type === 'in';
    return true;
}

export function logChat(type, text) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const safeText = normalizeLogText(text);

    // Always update stats regardless of verbosity
    if (type === 'in' || type === 'out') {
        STATE.turns = Math.floor(STATE.totalMessages / 2);
        const tc = $('#turn-counter');
        if (tc) tc.textContent = `${STATE.turns} turns`;
    }
    const lh = $('#stat-last-heard');
    if (lh) lh.textContent = ts;

    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    msg.dataset.type = type;
    if (!isVisibleForVerbosity(type)) msg.hidden = true;
    const prefix = type === 'in' ? '◂' : type === 'out' ? '▸' : '◆';

    const tsEl = document.createElement('span');
    tsEl.className = 'ts';
    tsEl.textContent = ts;

    const contentEl = document.createElement('span');
    contentEl.className = 'content';
    contentEl.textContent = `${prefix} ${safeText}`;

    msg.appendChild(tsEl);
    msg.appendChild(contentEl);
    chatLog.appendChild(msg);
    scheduleScroll();

    if (chatLog.children.length > MAX_MESSAGES) {
        while (chatLog.children.length > TRIM_TO) {
            chatLog.removeChild(chatLog.firstChild);
        }
    }
}

const VERBOSITY_CYCLE = ['all', 'chat', 'minimal'];
const VERBOSITY_LABELS = { all: 'ALL', chat: 'CHAT', minimal: 'MIN' };

function applyVerbosityFilter() {
    for (const msg of chatLog.children) {
        const type = msg.dataset.type;
        if (!type) continue;
        msg.hidden = !isVisibleForVerbosity(type);
    }
    scheduleScroll();
}

export function initVerbosityToggle() {
    const toggle = $('#verbosity-toggle');
    if (!toggle) return;
    toggle.textContent = VERBOSITY_LABELS[STATE.chatVerbosity];
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = VERBOSITY_CYCLE.indexOf(STATE.chatVerbosity);
        STATE.chatVerbosity = VERBOSITY_CYCLE[(idx + 1) % VERBOSITY_CYCLE.length];
        toggle.textContent = VERBOSITY_LABELS[STATE.chatVerbosity];
        applyVerbosityFilter();
    });
}
