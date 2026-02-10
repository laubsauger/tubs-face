import { STATE } from './state.js';
import { $, mouth, eyes, loadingBar } from './dom.js';

export function setExpression(expr) {
    STATE.expression = expr;
    $('#stat-expression').textContent = expr.toUpperCase();

    mouth.className = '';
    loadingBar.classList.remove('active');

    switch (expr) {
        case 'idle':
            break;
        case 'listening':
            mouth.className = '';
            break;
        case 'speaking':
            mouth.className = 'speaking';
            break;
        case 'thinking':
            mouth.className = 'thinking';
            loadingBar.classList.add('active');
            break;
        case 'smile':
            mouth.className = 'smile';
            break;
        case 'happy':
            mouth.className = 'smile';
            break;
    }
}

export function triggerBlink() {
    eyes.forEach(e => e.classList.add('blink'));
    setTimeout(() => eyes.forEach(e => e.classList.remove('blink')), 200);
}

export function blink() {
    eyes.forEach(eye => eye.classList.add('blink'));
    setTimeout(() => {
        eyes.forEach(eye => eye.classList.remove('blink'));
    }, 150);
}

export function startIdleLoop() {
    setInterval(() => {
        if (STATE.sleeping) return;
        blink();
    }, 4000 + Math.random() * 2000);

    setInterval(() => {
        if (STATE.sleeping || STATE.speaking || STATE.expression !== 'idle') return;

        const r = Math.random();
        if (r < 0.2) {
            setExpression('smile');
            setTimeout(() => {
                if (STATE.expression === 'smile') setExpression('idle');
            }, 2000);
        }
    }, 5000);
}
