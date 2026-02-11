// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Proactive Conversation — initiate chat when person is idle
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';

const PROACTIVE_DELAY_MS = 45000;    // 45s of silence before initiating
const PROACTIVE_COOLDOWN_MS = 60000; // 60s between proactive attempts
const PROACTIVE_JITTER_MS = 30000;   // 0-30s jitter → total 45-75s feels natural

let proactiveTimer = null;
let lastProactiveAt = 0;
let wsSendFn = null;

export function initProactive(getSendFn) {
    wsSendFn = getSendFn;
}

export function resetProactiveTimer() {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
    scheduleProactive();
}

export function cancelProactiveTimer() {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
}

function scheduleProactive() {
    if (proactiveTimer) return;
    if (!STATE.presenceDetected || STATE.sleeping) return;

    const jitter = Math.floor(Math.random() * PROACTIVE_JITTER_MS);
    proactiveTimer = setTimeout(() => {
        proactiveTimer = null;
        tryProactiveChat();
    }, PROACTIVE_DELAY_MS + jitter);
}

function tryProactiveChat() {
    if (!STATE.presenceDetected || STATE.sleeping || STATE.speaking) {
        scheduleProactive();
        return;
    }
    if (Date.now() - lastProactiveAt < PROACTIVE_COOLDOWN_MS) {
        scheduleProactive();
        return;
    }

    lastProactiveAt = Date.now();

    const names = STATE.personsPresent;
    let context;
    if (names.length > 0) {
        context = `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} standing here but hasn't said anything. Strike up a conversation.`;
    } else {
        context = 'Someone is nearby but hasn\'t spoken. Try to engage them.';
    }

    const ws = typeof wsSendFn === 'function' ? wsSendFn() : null;
    if (ws && ws.readyState === 1) {
        console.log('[Proactive] Triggering conversation:', context);
        ws.send(JSON.stringify({ type: 'proactive', context, faces: names }));
    }

    scheduleProactive();
}

export function onPresenceChanged(present) {
    if (present) {
        scheduleProactive();
    } else {
        cancelProactiveTimer();
    }
}
