import { STATE } from './state.js';
import { $, chatLog } from './dom.js';

const MAX_MESSAGES = 300;
const TRIM_TO = 200;
const draftNodes = new Map();

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

function getPrefix(type) {
    return type === 'in' ? '◂' : type === 'out' ? '▸' : '◆';
}

function updateLastHeard(ts) {
    const lh = $('#stat-last-heard');
    if (lh) lh.textContent = ts;
}

function isVisibleForVerbosity(type) {
    if (STATE.chatVerbosity === 'chat') return type !== 'sys';
    if (STATE.chatVerbosity === 'minimal') return type === 'in';
    return true;
}

function trimChatLogIfNeeded() {
    if (chatLog.children.length <= MAX_MESSAGES) return;
    while (chatLog.children.length > TRIM_TO) {
        chatLog.removeChild(chatLog.firstChild);
    }
    for (const [type, node] of draftNodes.entries()) {
        if (!node?.isConnected) {
            draftNodes.delete(type);
        }
    }
}

function buildMessageNode(type, ts, safeText, { draft = false } = {}) {
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    msg.dataset.type = type;
    msg.dataset.rawText = safeText;
    if (draft) {
        msg.classList.add('draft');
        msg.dataset.draft = '1';
        msg.dataset.draftType = type;
    }
    if (!isVisibleForVerbosity(type)) msg.hidden = true;

    const tsEl = document.createElement('span');
    tsEl.className = 'ts';
    tsEl.textContent = ts;

    const contentEl = document.createElement('span');
    contentEl.className = 'content';
    contentEl.textContent = `${getPrefix(type)} ${safeText}`;

    msg.appendChild(tsEl);
    msg.appendChild(contentEl);
    return msg;
}

function updateMessageNode(node, type, ts, safeText) {
    if (!node) return;
    node.dataset.rawText = safeText;
    node.dataset.type = type;
    const tsEl = node.querySelector('.ts');
    if (tsEl) tsEl.textContent = ts;
    const contentEl = node.querySelector('.content');
    if (contentEl) contentEl.textContent = `${getPrefix(type)} ${safeText}`;
    node.hidden = !isVisibleForVerbosity(type);
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
    updateLastHeard(ts);

    const msg = buildMessageNode(type, ts, safeText);
    chatLog.appendChild(msg);
    scheduleScroll();
    trimChatLogIfNeeded();
}

export function upsertChatDraft(type, text) {
    const safeText = normalizeLogText(text).trim();
    if (!safeText) {
        clearChatDraft(type);
        return;
    }
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    updateLastHeard(ts);

    let draft = draftNodes.get(type);
    if (!draft || !draft.isConnected) {
        draft = buildMessageNode(type, ts, safeText, { draft: true });
        chatLog.appendChild(draft);
        draftNodes.set(type, draft);
    } else {
        updateMessageNode(draft, type, ts, safeText);
    }

    scheduleScroll();
    trimChatLogIfNeeded();
}

export function commitChatDraft(type) {
    const draft = draftNodes.get(type);
    if (!draft || !draft.isConnected) {
        draftNodes.delete(type);
        return;
    }
    const safeText = String(draft.dataset.rawText || '').trim();
    if (!safeText) {
        draft.remove();
        draftNodes.delete(type);
        return;
    }
    draft.classList.remove('draft');
    delete draft.dataset.draft;
    delete draft.dataset.draftType;
    draftNodes.delete(type);
}

export function clearChatDraft(type) {
    const draft = draftNodes.get(type);
    if (draft?.isConnected) {
        draft.remove();
    }
    draftNodes.delete(type);
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
