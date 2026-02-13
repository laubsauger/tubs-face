import { STATE } from './state.js';

const AMBIENT_SRC = '/audio/tubs-robot-ambience-loop.mp3';
const SILENT_GAP_MS = 15000;
const FADE_IN_MS = 2000;
const HOLD_MS = 7000;
const FADE_OUT_MS = 2000;
const PEAK_GAIN = 0.05;
const DUCKED_GAIN = 0.018;
const STATE_POLL_MS = 400;
const PAUSE_IDLE_DELAY_MS = 600;

let initialized = false;
let audioEl = null;
let audioCtx = null;
let gainNode = null;
let sourceNode = null;
let usingWebAudio = false;

let envelope = 0;
let active = false;
let smallSpeaking = false;
let pulseToken = 0;
let statePollTimer = null;
let fallbackFadeTimer = null;
let pauseTimer = null;
let lastAppliedTargetGain = -1;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearFallbackFade() {
    if (!fallbackFadeTimer) return;
    clearInterval(fallbackFadeTimer);
    fallbackFadeTimer = null;
}

function clearPauseTimer() {
    if (!pauseTimer) return;
    clearTimeout(pauseTimer);
    pauseTimer = null;
}

function setElementVolume(target, durationMs) {
    if (!audioEl) return;
    const next = clamp01(target);
    clearFallbackFade();
    if (!durationMs || durationMs <= 0) {
        audioEl.volume = next;
        return;
    }

    const start = audioEl.volume;
    const delta = next - start;
    const steps = Math.max(1, Math.ceil(durationMs / 50));
    let i = 0;
    fallbackFadeTimer = setInterval(() => {
        i += 1;
        const t = Math.min(1, i / steps);
        audioEl.volume = clamp01(start + delta * t);
        if (t >= 1) {
            clearFallbackFade();
        }
    }, Math.max(16, Math.floor(durationMs / steps)));
}

function setGain(target, durationMs = 0) {
    const next = clamp01(target);
    if (usingWebAudio && gainNode && audioCtx) {
        const now = audioCtx.currentTime;
        const durSec = Math.max(0, Number(durationMs) || 0) / 1000;
        const from = Number(gainNode.gain.value) || 0;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(from, now);
        if (durSec > 0) {
            gainNode.gain.linearRampToValueAtTime(next, now + durSec);
        } else {
            gainNode.gain.setValueAtTime(next, now);
        }
        return;
    }
    setElementVolume(next, durationMs);
}

function ensureAudioGraph() {
    if (audioEl) return;

    audioEl = new Audio(AMBIENT_SRC);
    audioEl.loop = true;
    audioEl.preload = 'metadata';
    audioEl.volume = 0;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
        audioCtx = new AudioCtx();
        sourceNode = audioCtx.createMediaElementSource(audioEl);
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 0;
        sourceNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        usingWebAudio = true;
    } catch {
        usingWebAudio = false;
        audioCtx = null;
        sourceNode = null;
        gainNode = null;
    }
}

function isSpeechActive() {
    return Boolean(STATE.speaking || smallSpeaking);
}

function computeTargetGain() {
    if (!active) return 0;
    const peak = isSpeechActive() ? DUCKED_GAIN : PEAK_GAIN;
    return envelope * peak;
}

function applyTargetGain(durationMs = 180) {
    const target = computeTargetGain();
    if (Math.abs(target - lastAppliedTargetGain) < 0.001) return;
    lastAppliedTargetGain = target;
    setGain(target, durationMs);
}

async function ensurePlaybackReady() {
    ensureAudioGraph();
    if (!audioEl) return;

    if (audioCtx && audioCtx.state === 'suspended') {
        try {
            await audioCtx.resume();
        } catch {
            // ignore resume errors (autoplay gate)
        }
    }

    if (audioEl.paused) {
        try {
            await audioEl.play();
        } catch {
            // autoplay may block until gesture
        }
    }
}

function schedulePauseIfInactive() {
    clearPauseTimer();
    if (active || !audioEl) return;
    pauseTimer = setTimeout(() => {
        pauseTimer = null;
        if (active || !audioEl || audioEl.paused) return;
        audioEl.pause();
    }, PAUSE_IDLE_DELAY_MS);
}

function setEnvelope(nextEnvelope, durationMs) {
    envelope = clamp01(nextEnvelope);
    applyTargetGain(durationMs);
}

async function runPulseLoop(myToken) {
    while (initialized && myToken === pulseToken) {
        await sleep(SILENT_GAP_MS);
        if (!initialized || myToken !== pulseToken || !active) return;

        setEnvelope(1, FADE_IN_MS);
        await sleep(FADE_IN_MS + HOLD_MS);
        if (!initialized || myToken !== pulseToken || !active) return;

        setEnvelope(0, FADE_OUT_MS);
        await sleep(FADE_OUT_MS);
    }
}

function startPulseLoop() {
    pulseToken += 1;
    const myToken = pulseToken;
    void runPulseLoop(myToken);
}

function stopPulseLoop() {
    pulseToken += 1;
}

function shouldBeActive() {
    return STATE.ambientAudioEnabled !== false && !STATE.muted && !STATE.sleeping && !document.hidden;
}

function syncActiveState() {
    const nextActive = shouldBeActive();
    if (nextActive === active) {
        if (active) applyTargetGain(140);
        return;
    }

    active = nextActive;
    if (active) {
        clearPauseTimer();
        void ensurePlaybackReady();
        setEnvelope(0, 120);
        startPulseLoop();
        return;
    }

    stopPulseLoop();
    setEnvelope(0, 220);
    schedulePauseIfInactive();
}

function handleSpeechObserved(event) {
    const detail = event?.detail || {};
    const actor = String(detail.actor || '').toLowerCase();
    if (actor !== 'small') return;
    const state = String(detail.state || '').toLowerCase();
    smallSpeaking = state === 'start';
    applyTargetGain(120);
}

function bindUnlockListeners() {
    const tryUnlock = () => {
        if (!active) return;
        void ensurePlaybackReady();
    };
    window.addEventListener('pointerdown', tryUnlock, { passive: true });
    window.addEventListener('keydown', tryUnlock);
}

export function initAmbientAudio() {
    if (initialized) return;
    initialized = true;

    bindUnlockListeners();
    window.addEventListener('tubs:head-speech-observed', handleSpeechObserved);
    document.addEventListener('visibilitychange', syncActiveState);

    syncActiveState();
    statePollTimer = setInterval(syncActiveState, STATE_POLL_MS);
}
