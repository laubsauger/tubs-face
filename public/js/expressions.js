import { STATE } from './state.js';
import { $, face, eyes, loadingBar } from './dom.js';

let idleVariant = 'soft';
const EXPRESSION_MIN_HOLD_MS = Object.freeze({
    smile: 1000,
    happy: 1400,
    sad: 1800,
    crying: 2600,
    love: 1600,
});

let holdUntilTs = 0;
let heldExpression = '';
let holdTimer = null;
let pendingExpression = null;

function applyFaceClass(expr) {
    if (expr === 'idle') {
        face.className = idleVariant === 'flat' ? 'idle-flat' : '';
        return;
    }
    face.className = expr;
}

function setIdleVariant(nextVariant) {
    idleVariant = nextVariant === 'flat' ? 'flat' : 'soft';
    if (STATE.expression === 'idle') {
        applyFaceClass('idle');
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
    loadingBar.classList.toggle('active', expr === 'thinking');
    applyExpressionHold(expr, options);
    return true;
}

export function triggerBlink() {
    eyes.forEach(e => e.classList.add('blink'));
    setTimeout(() => eyes.forEach(e => e.classList.remove('blink')), 150);
}

export function blink() {
    eyes.forEach(eye => eye.classList.add('blink'));
    setTimeout(() => {
        eyes.forEach(eye => eye.classList.remove('blink'));
    }, 150);
}

export function startIdleLoop() {
    setIdleVariant('soft');

    setInterval(() => {
        if (STATE.sleeping) return;
        blink();
    }, 4000 + Math.random() * 2000);

    setInterval(() => {
        if (STATE.sleeping || STATE.speaking || STATE.expression !== 'idle') return;

        const r = Math.random();
        if (r < 0.45) {
            setExpression('smile');
            setTimeout(() => {
                if (STATE.expression === 'smile') setExpression('idle');
            }, 1300 + Math.random() * 900);
            return;
        }

        // Keep idle approachable on average, but preserve occasional straight-neutral look.
        setIdleVariant(r < 0.85 ? 'soft' : 'flat');
    }, 5000);
}
