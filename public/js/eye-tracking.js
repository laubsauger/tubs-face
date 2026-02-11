import { eyes, face, mouth } from './dom.js';
import { setFaceRendererGaze } from './face-renderer.js';

const EYE_MAX_X = 236;
const EYE_MAX_Y = 128;
const MOUTH_MAX_X = 208;
const MOUTH_MAX_Y = 104;
const FACE_MAX_X = 32;
const FACE_MAX_Y = 20;

const INPUT_DEADZONE = 0.035;
const INPUT_SHAPE_EXPONENT = 0.82;

const SPRING_STIFFNESS = 185;
const SPRING_DAMPING = 22;
const STOP_POS_EPS = 0.0012;
const STOP_VEL_EPS = 0.0012;

let curX = 0;
let curY = 0;
let velX = 0;
let velY = 0;
let targetX = 0;
let targetY = 0;
let animating = false;
let lastTickMs = 0;

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function easeInput(v) {
    const c = clamp(v, -1, 1);
    const sign = Math.sign(c);
    const mag = Math.abs(c);

    if (mag <= INPUT_DEADZONE) return 0;

    const normalized = (mag - INPUT_DEADZONE) / (1 - INPUT_DEADZONE);
    const shaped = Math.pow(normalized, INPUT_SHAPE_EXPONENT);
    return sign * clamp(shaped, 0, 1);
}

function stepAxis(cur, vel, target, dt) {
    const accel = (target - cur) * SPRING_STIFFNESS;
    vel += accel * dt;
    vel *= Math.exp(-SPRING_DAMPING * dt);
    cur += vel * dt;
    return [cur, vel];
}

function applyGaze(x, y) {
    const ex = clamp(x * EYE_MAX_X, -EYE_MAX_X, EYE_MAX_X);
    const ey = clamp(y * EYE_MAX_Y, -EYE_MAX_Y, EYE_MAX_Y);

    eyes.forEach((eye) => {
        eye.style.setProperty('--look-x', `${ex.toFixed(2)}px`);
        eye.style.setProperty('--look-y', `${ey.toFixed(2)}px`);
    });

    const mx = clamp(x * MOUTH_MAX_X, -MOUTH_MAX_X, MOUTH_MAX_X);
    const my = clamp(y * MOUTH_MAX_Y, -MOUTH_MAX_Y, MOUTH_MAX_Y);
    mouth.style.setProperty('--mouth-look-x', `${mx.toFixed(2)}px`);
    mouth.style.setProperty('--mouth-look-y', `${my.toFixed(2)}px`);
    setFaceRendererGaze({ eyeX: ex, eyeY: ey, mouthX: mx, mouthY: my });

    const fx = clamp(x * FACE_MAX_X, -FACE_MAX_X, FACE_MAX_X);
    const fy = clamp(y * FACE_MAX_Y, -FACE_MAX_Y, FACE_MAX_Y);
    face.style.setProperty('--face-look-x', `${fx.toFixed(2)}px`);
    face.style.setProperty('--face-look-y', `${fy.toFixed(2)}px`);
}

function tick(nowMs) {
    if (!lastTickMs) lastTickMs = nowMs;
    const dt = clamp((nowMs - lastTickMs) / 1000, 0.008, 0.04);
    lastTickMs = nowMs;

    [curX, velX] = stepAxis(curX, velX, targetX, dt);
    [curY, velY] = stepAxis(curY, velY, targetY, dt);
    applyGaze(curX, curY);

    const doneX = Math.abs(targetX - curX) < STOP_POS_EPS && Math.abs(velX) < STOP_VEL_EPS;
    const doneY = Math.abs(targetY - curY) < STOP_POS_EPS && Math.abs(velY) < STOP_VEL_EPS;
    if (doneX && doneY) {
        curX = targetX;
        curY = targetY;
        velX = 0;
        velY = 0;
        applyGaze(curX, curY);
        animating = false;
        lastTickMs = 0;
        return;
    }

    requestAnimationFrame(tick);
}

function ensureAnimationLoop() {
    if (animating) return;
    animating = true;
    requestAnimationFrame(tick);
}

export function lookAt(x, y) {
    targetX = easeInput(x);
    targetY = easeInput(y);
    ensureAnimationLoop();
}

export function resetGaze() {
    targetX = 0;
    targetY = 0;
    ensureAnimationLoop();
}
