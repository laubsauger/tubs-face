import { STATE } from './state.js';
import { $, chatLog } from './dom.js';

export function escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

export function logChat(type, text) {
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const prefix = type === 'in' ? '◂' : type === 'out' ? '▸' : '◆';
    msg.innerHTML = `<span class="ts">${ts}</span><span class="content">${prefix} ${escapeHTML(text)}</span>`;
    chatLog.appendChild(msg);
    chatLog.scrollTop = chatLog.scrollHeight;

    while (chatLog.children.length > 100) {
        chatLog.removeChild(chatLog.firstChild);
    }

    if (type === 'in' || type === 'out') {
        STATE.turns = Math.floor(STATE.totalMessages / 2);
        $('#turn-counter').textContent = `${STATE.turns} turns`;
    }
    $('#stat-last-heard').textContent = ts;
}
