import { STATE } from './state.js';
import { $, face, eyes, loadingBar } from './dom.js';

let idleVariant = 'soft';

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

export function setExpression(expr) {
    STATE.expression = expr;
    $('#stat-expression').textContent = expr.toUpperCase();

    // Remove all expression classes, set new one
    applyFaceClass(expr);
    loadingBar.classList.toggle('active', expr === 'thinking');
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
