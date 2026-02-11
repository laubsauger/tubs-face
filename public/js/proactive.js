// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Proactive Conversation — initiate chat when person is idle
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';
import { getWs } from './websocket.js';

const PROACTIVE_DELAY_MS = 20000;    // 20s of silence before initiating
const PROACTIVE_COOLDOWN_MS = 45000; // 45s between proactive attempts
const PROACTIVE_JITTER_MS = 8000;    // randomize timing so it feels natural

let proactiveTimer = null;
let lastProactiveAt = 0;

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
        // Conditions changed — reschedule
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

    const ws = getWs();
    if (ws && ws.readyState === 1) {
        console.log('[Proactive] Triggering conversation:', context);
        ws.send(JSON.stringify({ type: 'proactive', context, faces: names }));
    }

    // Schedule next check
    scheduleProactive();
}

export function onPresenceChanged(present) {
    if (present) {
        scheduleProactive();
    } else {
        cancelProactiveTimer();
    }
}
