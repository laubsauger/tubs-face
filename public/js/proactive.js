// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Proactive Conversation — initiate chat when person is idle
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';

const PROACTIVE_DELAY_MS = 45000;    // 45s of silence before initiating
const PROACTIVE_COOLDOWN_MS = 60000; // 60s between proactive attempts
const PROACTIVE_JITTER_MS = 30000;   // 0-30s jitter → total 45-75s feels natural

// Varied prompts so the LLM doesn't repeat itself
const KNOWN_PERSON_PROMPTS = [
    (n) => `${n} is standing nearby, silent. Say something that makes it impossible not to reply.`,
    (n) => `${n} has been quiet for a while. Make a weird observation or ask something unexpected.`,
    (n) => `${n} is just standing there. Tease them about the silence or make up a theory about what they're thinking.`,
    (n) => `${n} hasn't said a word. Try a completely different angle — a random question, a hot take, a dare, anything fresh.`,
    (n) => `${n} is being quiet. Challenge them to something small and silly, or share a wild opinion.`,
    (n) => `${n} seems distracted. Pull them back in with something absurd or genuinely curious.`,
    (n) => `${n} is still here but not talking. Pretend you just noticed something interesting about them.`,
    (n) => `${n} is giving you the silent treatment. React to it — be dramatic, playful, or mock-offended.`,
];

const UNKNOWN_PERSON_PROMPTS = [
    'Someone is nearby but hasn\'t spoken. Break the ice with something unexpected.',
    'A stranger is standing there silently. Say something that demands a response.',
    'You can see someone but they won\'t talk. Make a wild guess about who they are or what they want.',
    'Quiet stranger nearby. Try a hot take, a random question, or just be dramatically offended by the silence.',
    'Someone is lurking. Call it out in a funny way or ask them something no one would expect.',
    'Person detected, zero words spoken. React to the awkward silence — be theatrical about it.',
    'A silent observer is near. Make up a backstory for them or challenge them to prove you wrong.',
    'Someone is just... standing there. Poke the bear. Say something impossible to ignore.',
];

let lastPromptIdx = -1;

function pickRandom(arr) {
    let idx;
    do {
        idx = Math.floor(Math.random() * arr.length);
    } while (idx === lastPromptIdx && arr.length > 1);
    lastPromptIdx = idx;
    return arr[idx];
}

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
        const nameStr = names.join(' and ');
        const template = pickRandom(KNOWN_PERSON_PROMPTS);
        context = template(nameStr);
    } else {
        context = pickRandom(UNKNOWN_PERSON_PROMPTS);
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
