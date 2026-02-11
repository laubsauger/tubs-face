import { STATE } from './state.js';
import { face } from './dom.js';
import { setExpression } from './expressions.js';

const BASELINE = Object.freeze({
    pos: 0.24,
    neg: 0.06,
    arousal: 0.2,
});

const currentMood = {
    pos: BASELINE.pos,
    neg: BASELINE.neg,
    arousal: BASELINE.arousal,
};

const targetMood = {
    pos: BASELINE.pos,
    neg: BASELINE.neg,
    arousal: BASELINE.arousal,
};

const EXPRESSION_HARD_LOCK = new Set(['love', 'crying', 'thinking', 'speaking']);
const MOOD_HOLD_MS = 1700;
const PULSE_DURATION_MS = 920;
const EXPRESSION_PULSE_DURATIONS_MS = Object.freeze({
    smile: 980,
    happy: 1300,
    sad: 3200,
    thinking: 1100,
    love: 1600,
});
const EXPRESSIVE_PULSES = new Set(Object.keys(EXPRESSION_PULSE_DURATIONS_MS));

let holdUntil = 0;
let rafId = 0;
let lastTickMs = 0;
let pulseTimer = null;
let lastAutoPulseAt = 0;

function clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

let prevMoodPos = -1;
let prevMoodNeg = -1;
let prevMoodArousal = -1;
const MOOD_EPSILON = 0.002;

function applyMoodVars() {
    if (
        Math.abs(currentMood.pos - prevMoodPos) < MOOD_EPSILON &&
        Math.abs(currentMood.neg - prevMoodNeg) < MOOD_EPSILON &&
        Math.abs(currentMood.arousal - prevMoodArousal) < MOOD_EPSILON
    ) return;
    prevMoodPos = currentMood.pos;
    prevMoodNeg = currentMood.neg;
    prevMoodArousal = currentMood.arousal;
    face.style.setProperty('--mood-pos', currentMood.pos.toFixed(3));
    face.style.setProperty('--mood-neg', currentMood.neg.toFixed(3));
    face.style.setProperty('--mood-arousal', currentMood.arousal.toFixed(3));
}

function canPulseExpression() {
    if (STATE.sleeping || STATE.speaking) return false;
    return !EXPRESSION_HARD_LOCK.has(STATE.expression);
}

function pulseExpression(expr, durationMs = PULSE_DURATION_MS) {
    if (!canPulseExpression()) return;
    if (pulseTimer) clearTimeout(pulseTimer);
    setExpression(expr);
    pulseTimer = setTimeout(() => {
        pulseTimer = null;
        if (STATE.expression === expr && !STATE.speaking && !STATE.sleeping) {
            setExpression('idle');
        }
    }, durationMs);
}

function maybePulseFromMood(mood) {
    if (!canPulseExpression()) return;
    if (STATE.expression !== 'idle' && STATE.expression !== 'smile') return;

    if (mood.neg >= 0.74 && mood.arousal >= 0.28) {
        pulseExpression('sad');
        return;
    }
    if (mood.pos >= 0.8) {
        pulseExpression('happy');
        return;
    }
    if (mood.pos >= 0.58 && Math.random() < 0.55) {
        pulseExpression('smile', 760);
    }
}

function maybeAutoPulse(nowTs) {
    if (nowTs - lastAutoPulseAt < 1350) return;
    if (!canPulseExpression()) return;
    if (STATE.expression !== 'idle') return;

    if (currentMood.neg >= 0.66 && currentMood.arousal >= 0.24) {
        lastAutoPulseAt = nowTs;
        maybePulseFromMood(currentMood);
        return;
    }

    if (currentMood.pos >= 0.64) {
        lastAutoPulseAt = nowTs;
        maybePulseFromMood(currentMood);
    }
}

function nudgeTarget(impulse, sourceGain = 1) {
    const gain = clamp01(sourceGain);
    targetMood.pos = clamp01(targetMood.pos * 0.54 + impulse.pos * 0.46 * gain);
    targetMood.neg = clamp01(targetMood.neg * 0.54 + impulse.neg * 0.46 * gain);
    targetMood.arousal = clamp01(targetMood.arousal * 0.5 + impulse.arousal * 0.5 * gain);
    holdUntil = Date.now() + MOOD_HOLD_MS;
}

function tick(nowMs) {
    if (!lastTickMs) lastTickMs = nowMs;
    const dt = Math.max(8, nowMs - lastTickMs);
    lastTickMs = nowMs;

    const now = Date.now();
    if (now > holdUntil) {
        const drift = STATE.sleeping ? 0.11 : 0.045;
        targetMood.pos = lerp(targetMood.pos, BASELINE.pos, drift);
        targetMood.neg = lerp(targetMood.neg, BASELINE.neg, drift);
        targetMood.arousal = lerp(targetMood.arousal, STATE.sleeping ? 0.08 : BASELINE.arousal, drift);
    }

    const step = Math.min(0.28, 0.06 + dt / 400);
    currentMood.pos = lerp(currentMood.pos, targetMood.pos, step);
    currentMood.neg = lerp(currentMood.neg, targetMood.neg, step);
    currentMood.arousal = lerp(currentMood.arousal, targetMood.arousal, step);

    applyMoodVars();
    maybeAutoPulse(now);
    rafId = requestAnimationFrame(tick);
}

export function initEmotionEngine() {
    if (rafId) return;
    applyMoodVars();
    rafId = requestAnimationFrame(tick);
}

export function pushEmotionImpulse({ pos = 0, neg = 0, arousal = 0 }, source = 'system') {
    const sourceGain = source === 'spoken' ? 0.8 : 1.0;
    nudgeTarget({
        pos: clamp01(pos),
        neg: clamp01(neg),
        arousal: clamp01(arousal),
    }, sourceGain);
}

export function suggestEmotionExpression(expr) {
    if (!EXPRESSIVE_PULSES.has(expr)) return;
    const duration = EXPRESSION_PULSE_DURATIONS_MS[expr] || PULSE_DURATION_MS;
    pulseExpression(expr, duration);
}
