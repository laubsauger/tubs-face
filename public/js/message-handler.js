import { STATE } from './state.js';
import { $, loadingBar } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression } from './expressions.js';
import { enqueueSpeech } from './tts.js';
import { hideDonationQr } from './donation-ui.js';
import { enterSleep, exitSleep } from './sleep.js';

const DONATION_CONFIRM_RE = /\b(?:i(?:'ve| have| just)?\s*(?:sent|donated|paid|venmoed)|sent you|i got you|i did donate|donation sent|venmo sent|paid you)\b/i;

function trackDonationSignal(text) {
    if (!text) return;
    if (DONATION_CONFIRM_RE.test(text)) {
        STATE.lastDonationSignalAt = Date.now();
        logChat('sys', 'Donation signal detected.');
    }
}

export function handleMessage(msg) {
    if (msg.type !== 'ping' && msg.type !== 'stats' && msg.type !== 'config') {
        STATE.lastActivity = Date.now();
    }

    switch (msg.type) {
        case 'speak':
            enqueueSpeech(msg.text, msg.donation);
            logChat('in', msg.text);
            STATE.totalMessages++;
            break;
        case 'incoming':
            trackDonationSignal(msg.text);
            logChat('out', msg.text);
            setExpression('listening');
            break;
        case 'thinking':
            setExpression('thinking');
            loadingBar.classList.add('active');
            break;
        case 'expression':
            setExpression(msg.expression);
            break;
        case 'system':
            logChat('sys', msg.text);
            break;
        case 'error':
            logChat('sys', `ERROR: ${msg.text}`);
            loadingBar.classList.remove('active');
            setExpression('idle');
            break;
        case 'sleep':
            hideDonationQr();
            enterSleep();
            break;
        case 'wake':
            exitSleep();
            break;
        case 'stats':
            if (msg.latency != null) $('#stat-resp-time').textContent = `${msg.latency} ms`;
            if (msg.tokens) {
                if (msg.totals) {
                    STATE.tokensIn = msg.totals.in ?? STATE.tokensIn;
                    STATE.tokensOut = msg.totals.out ?? STATE.tokensOut;
                } else {
                    STATE.tokensIn += msg.tokens.in || 0;
                    STATE.tokensOut += msg.tokens.out || 0;
                }
                $('#stat-tok-in').textContent = STATE.tokensIn;
                $('#stat-tok-out').textContent = STATE.tokensOut;
            }
            if (msg.model) {
                STATE.model = msg.model;
                $('#stat-model').textContent = msg.model;
            }
            if (msg.cost != null) {
                if (msg.totals && msg.totals.cost != null) {
                    STATE.totalCost = msg.totals.cost;
                } else {
                    STATE.totalCost += msg.cost;
                }
                const precision = STATE.totalCost >= 1 ? 2 : 4;
                $('#stat-cost').textContent = `$${STATE.totalCost.toFixed(precision)}`;
            }
            break;
        case 'config':
            if (msg.sleepTimeout) {
                STATE.sleepTimeout = msg.sleepTimeout;
                const secs = Math.round(msg.sleepTimeout / 1000);
                const slider = document.getElementById('sleep-timeout');
                const label = document.getElementById('sleep-timeout-val');
                if (slider) slider.value = secs;
                if (label) label.textContent = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
            }
            if (msg.model) {
                STATE.model = msg.model;
                $('#stat-model').textContent = msg.model;
            }
            break;
    }
}
