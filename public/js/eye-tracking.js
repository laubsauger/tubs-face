import { eyes, face } from './dom.js';

// ── Displacement ranges ──
const EYE_MAX_X = 90;   // px – horizontal eye displacement
const EYE_MAX_Y = 50;   // px – vertical eye displacement
const FACE_MAX_X = 30;  // px – horizontal face displacement
const FACE_MAX_Y = 16;  // px – vertical face displacement

// ── Smoothing (exponential moving average) ──
const LERP = 0.18;      // 0 = frozen, 1 = instant (0.15-0.25 feels organic)
let curX = 0;
let curY = 0;
let targetX = 0;
let targetY = 0;
let animating = false;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function tick() {
    const dx = targetX - curX;
    const dy = targetY - curY;

    // Stop animating once close enough
    if (Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15) {
        curX = targetX;
        curY = targetY;
        applyGaze(curX, curY);
        animating = false;
        return;
    }

    curX += dx * LERP;
    curY += dy * LERP;
    applyGaze(curX, curY);
    requestAnimationFrame(tick);
}

function applyGaze(x, y) {
    // Eyes move more for a natural parallax effect
    const ex = clamp(x * EYE_MAX_X, -EYE_MAX_X, EYE_MAX_X);
    const ey = clamp(y * EYE_MAX_Y, -EYE_MAX_Y, EYE_MAX_Y);
    eyes.forEach(e => {
        e.style.setProperty('--look-x', `${ex}px`);
        e.style.setProperty('--look-y', `${ey}px`);
    });

    // Face shifts subtly in the same direction
    const fx = clamp(x * FACE_MAX_X, -FACE_MAX_X, FACE_MAX_X);
    const fy = clamp(y * FACE_MAX_Y, -FACE_MAX_Y, FACE_MAX_Y);
    face.style.setProperty('--face-look-x', `${fx}px`);
    face.style.setProperty('--face-look-y', `${fy}px`);
}

export function lookAt(x, y) {
    targetX = x;
    targetY = y;
    if (!animating) {
        animating = true;
        requestAnimationFrame(tick);
    }
}

export function resetGaze() {
    targetX = 0;
    targetY = 0;
    if (!animating) {
        animating = true;
        requestAnimationFrame(tick);
    }
}
