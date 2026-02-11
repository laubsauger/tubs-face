import { STATE } from './state.js';
import { $, chatLog } from './dom.js';

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

export function logChat(type, text) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Always update stats regardless of verbosity
    if (type === 'in' || type === 'out') {
        STATE.turns = Math.floor(STATE.totalMessages / 2);
        $('#turn-counter').textContent = `${STATE.turns} turns`;
    }
    $('#stat-last-heard').textContent = ts;

    // Filter based on verbosity
    if (STATE.chatVerbosity === 'chat' && type === 'sys') return;
    if (STATE.chatVerbosity === 'minimal' && type !== 'in') return;

    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    const prefix = type === 'in' ? '◂' : type === 'out' ? '▸' : '◆';
    msg.innerHTML = `<span class="ts">${ts}</span><span class="content">${prefix} ${escapeHTML(text)}</span>`;
    chatLog.appendChild(msg);
    scheduleScroll();

    while (chatLog.children.length > 100) {
        chatLog.removeChild(chatLog.firstChild);
    }
}

const VERBOSITY_CYCLE = ['all', 'chat', 'minimal'];
const VERBOSITY_LABELS = { all: 'ALL', chat: 'CHAT', minimal: 'MIN' };

export function initVerbosityToggle() {
    const toggle = $('#verbosity-toggle');
    if (!toggle) return;
    toggle.textContent = VERBOSITY_LABELS[STATE.chatVerbosity];
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = VERBOSITY_CYCLE.indexOf(STATE.chatVerbosity);
        STATE.chatVerbosity = VERBOSITY_CYCLE[(idx + 1) % VERBOSITY_CYCLE.length];
        toggle.textContent = VERBOSITY_LABELS[STATE.chatVerbosity];
    });
}
