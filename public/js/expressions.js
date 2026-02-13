import { STATE } from './state.js';
import { $, face, eyes, loadingBar } from './dom.js';
import { setFaceRendererExpression, setFaceRendererSpeaking, blinkSvgEyes } from './face-renderer.js';
import { lookAt, resetGaze } from './eye-tracking.js';
import { startIdleBehavior } from './idle-behavior.js';

let idleVariant = 'soft';
const EXPRESSION_MIN_HOLD_MS = Object.freeze({
    smile: 1000,
    happy: 1400,
    sad: 3200,
    crying: 4200,
    love: 1600,
});

let holdUntilTs = 0;
let heldExpression = '';
let holdTimer = null;
let pendingExpression = null;
let stopIdleBehavior = null;
const blinkListeners = new Set();

function randomBlinkDurationMs() {
    return 95 + Math.floor(Math.random() * 90); // 95-184ms
}

function runBlink(durationMs = randomBlinkDurationMs()) {
    const ms = Math.max(70, Math.min(260, Number(durationMs) || 140));
    eyes.forEach((eye) => eye.classList.add('blink'));
    setTimeout(() => {
        eyes.forEach((eye) => eye.classList.remove('blink'));
    }, ms);
    blinkSvgEyes();
}

function applyFaceClass(expr) {
    const wasSpeaking = face.classList.contains('speaking');
    const hadSvg = face.classList.contains('use-svg-renderer');
    if (expr === 'idle') {
        face.className = idleVariant === 'flat' ? 'idle-flat' : '';
    } else {
        face.className = expr;
    }
    if (hadSvg) face.classList.add('use-svg-renderer');
    if (wasSpeaking) face.classList.add('speaking');
}

function setIdleVariant(nextVariant) {
    idleVariant = nextVariant === 'flat' ? 'flat' : 'soft';
    if (STATE.expression === 'idle') {
        applyFaceClass('idle');
        setFaceRendererExpression('idle');
    }
}

function clearHoldTimer() {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = null;
}

function schedulePendingExpressionApply() {
    clearHoldTimer();
    if (!pendingExpression) return;
    const wait = Math.max(0, holdUntilTs - Date.now());
    holdTimer = setTimeout(() => {
        holdTimer = null;
        const next = pendingExpression;
        pendingExpression = null;
        if (!next) return;
        setExpression(next.expr, next.options);
    }, wait + 8);
}

function isHoldLocked(nextExpression, force) {
    if (force) return false;
    if (Date.now() >= holdUntilTs) return false;
    if (!heldExpression) return false;
    if (nextExpression === heldExpression) return false;
    return true;
}

function applyExpressionHold(expr, options = {}) {
    const explicitHoldMs = Number(options.holdMs);
    const holdMs = Number.isFinite(explicitHoldMs)
        ? Math.max(0, explicitHoldMs)
        : (EXPRESSION_MIN_HOLD_MS[expr] || 0);

    if (options.skipHold || holdMs <= 0) {
        holdUntilTs = 0;
        heldExpression = '';
        clearHoldTimer();
        return;
    }

    heldExpression = expr;
    holdUntilTs = Date.now() + holdMs;
}

export function setExpression(expr, options = {}) {
    const force = Boolean(options.force);
    if (isHoldLocked(expr, force)) {
        pendingExpression = { expr, options };
        schedulePendingExpressionApply();
        return false;
    }

    pendingExpression = null;
    clearHoldTimer();

    STATE.expression = expr;
    $('#stat-expression').textContent = expr.toUpperCase();

    // Remove all expression classes, set new one
    applyFaceClass(expr);
    setFaceRendererExpression(expr);
    loadingBar.classList.toggle('active', expr === 'thinking');
    applyExpressionHold(expr, options);
    return true;
}

export function triggerBlink() {
    for (const listener of blinkListeners) {
        try {
            listener();
        } catch {
            // ignore listener errors
        }
    }
    runBlink();
}

export function blink() {
    for (const listener of blinkListeners) {
        try {
            listener();
        } catch {
            // ignore listener errors
        }
    }
    runBlink();
}

export function onBlink(listener) {
    if (typeof listener !== 'function') return () => {};
    blinkListeners.add(listener);
    return () => {
        blinkListeners.delete(listener);
    };
}

export function startSpeaking() {
    face.classList.add('speaking');
    setFaceRendererSpeaking(true);
}

export function stopSpeaking() {
    face.classList.remove('speaking');
    setFaceRendererSpeaking(false);
}

export function startIdleLoop() {
    if (typeof stopIdleBehavior === 'function') return;
    setIdleVariant('soft');
    stopIdleBehavior = startIdleBehavior({
        isSleeping: () => STATE.sleeping,
        isSpeaking: () => STATE.speaking,
        getExpression: () => STATE.expression,
        setExpression: (expr) => setExpression(expr),
        setIdleVariant,
        blink,
        lookAt,
        resetGaze,
        canLookAround: () => !STATE.presenceDetected,
    });
}
