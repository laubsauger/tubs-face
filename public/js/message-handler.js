import { STATE } from './state.js';
import { $, loadingBar } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression } from './expressions.js';
import { enqueueSpeech } from './tts.js';
import { enterSleep, exitSleep } from './sleep.js';

export function handleMessage(msg) {
    if (msg.type !== 'ping' && msg.type !== 'stats' && msg.type !== 'config') {
        STATE.lastActivity = Date.now();
    }

    switch (msg.type) {
        case 'speak':
            enqueueSpeech(msg.text);
            logChat('in', msg.text);
            STATE.totalMessages++;
            break;
        case 'incoming':
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
            enterSleep();
            break;
        case 'wake':
            exitSleep();
            break;
        case 'stats':
            if (msg.latency) $('#stat-resp-time').textContent = `${msg.latency} ms`;
            if (msg.tokens) {
                STATE.tokensIn += msg.tokens.in || 0;
                STATE.tokensOut += msg.tokens.out || 0;
                $('#stat-tok-in').textContent = STATE.tokensIn;
                $('#stat-tok-out').textContent = STATE.tokensOut;
            }
            if (msg.model) {
                STATE.model = msg.model;
                $('#stat-model').textContent = msg.model;
            }
            if (msg.cost != null) {
                STATE.totalCost += msg.cost;
                $('#stat-cost').textContent = `$${STATE.totalCost.toFixed(4)}`;
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
