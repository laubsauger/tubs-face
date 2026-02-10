import { STATE } from './state.js';
import { $} from './dom.js';
import { logChat } from './chat-log.js';
import { handleMessage } from './message-handler.js';

let ws = null;
let pingInterval = null;
let lastPingTs = null;

export function getWs() {
    return ws;
}

export function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
        STATE.connected = true;
        updateConnectionUI(true);
        logChat('sys', 'Connected to bridge server');
        startPing();
    };

    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            handleMessage(msg);
        } catch (err) {
            console.error('Bad WS message:', err);
        }
    };

    ws.onclose = () => {
        STATE.connected = false;
        updateConnectionUI(false);
        logChat('sys', 'Disconnected — reconnecting...');
        stopPing();
        setTimeout(connectWS, 3000);
    };

    ws.onerror = () => {
        ws.close();
    };
}

function startPing() {
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === 1) {
            lastPingTs = Date.now();
            ws.send(JSON.stringify({ type: 'ping', ts: lastPingTs }));
        }
    }, 5000);
}

function stopPing() {
    clearInterval(pingInterval);
}

export function updateConnectionUI(isConnected) {
    const dot = $('#conn-dot');
    const headerDot = $('#header-conn-dot');
    const val = $('#stat-conn');

    if (isConnected) {
        dot.className = 'dot green';
        if (headerDot) headerDot.className = 'dot green header-dot';
        val.innerHTML = '<span class="dot green" id="conn-dot"></span>Online';
        val.classList.remove('offline');
        val.classList.add('online');
    } else {
        dot.className = 'dot red';
        if (headerDot) headerDot.className = 'dot red header-dot';
        val.innerHTML = '<span class="dot red" id="conn-dot"></span>Offline';
        val.classList.remove('online');
        val.classList.add('offline');
    }
}
