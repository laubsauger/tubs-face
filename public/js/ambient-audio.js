import { STATE } from './state.js';

const AMBIENT_SRC = '/audio/tubs-robot-ambience-loop.mp3';
const PULSE_INTERVAL_MS = 12000;
const FADE_IN_MS = 2000;
const HOLD_MS = 7000;
const FADE_OUT_MS = 2000;
const PEAK_GAIN = 0.11;
const DUCKED_GAIN = 0.045;
const BASE_ENVELOPE = 0.45;
const SLEEP_GAIN_FACTOR = 0.72;
const STATE_POLL_MS = 400;
const PAUSE_IDLE_DELAY_MS = 600;
const DIAG_THROTTLE_MS = 1200;
const PLAYBACK_RECOVERY_MS = 1200;
const PLAY_PROMISE_TIMEOUT_MS = 1600;

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
let lastPlaybackWarnAt = 0;
let lastDiagAt = 0;
let lastRecoveryAt = 0;

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const tid = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        promise.then((value) => {
            if (settled) return;
            settled = true;
            clearTimeout(tid);
            resolve(value);
        }).catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(tid);
            reject(err);
        });
    });
}

function warnPlayback(message, error) {
    const now = Date.now();
    if (now - lastPlaybackWarnAt < 5000) return;
    lastPlaybackWarnAt = now;
    if (error) {
        console.warn(`[Ambient] ${message}`, error);
        return;
    }
    console.warn(`[Ambient] ${message}`);
}

function currentCtxState() {
    if (!audioCtx) return 'none';
    return String(audioCtx.state || 'unknown');
}

function currentMediaErrorCode() {
    const err = audioEl?.error;
    if (!err) return 0;
    return Number(err.code) || 0;
}

function snapshot(reason) {
    return {
        reason,
        active,
        envelope: Number(envelope.toFixed(3)),
        targetGain: Number(computeTargetGain().toFixed(4)),
        gainApplied: Number((lastAppliedTargetGain >= 0 ? lastAppliedTargetGain : 0).toFixed(4)),
        usingWebAudio,
        ctx: currentCtxState(),
        paused: Boolean(audioEl?.paused),
        readyState: Number(audioEl?.readyState || 0),
        networkState: Number(audioEl?.networkState || 0),
        mediaError: currentMediaErrorCode(),
        currentTime: Number((audioEl?.currentTime || 0).toFixed(2)),
        elVolume: Number((audioEl?.volume || 0).toFixed(4)),
        gainValue: Number((gainNode?.gain?.value || 0).toFixed(4)),
        ambientEnabled: STATE.ambientAudioEnabled !== false,
        muted: Boolean(STATE.muted),
        sleeping: Boolean(STATE.sleeping),
        hidden: Boolean(document.hidden),
        speaking: Boolean(STATE.speaking),
        smallSpeaking: Boolean(smallSpeaking),
    };
}

function diag(reason, force = false) {
    const now = Date.now();
    if (!force && now - lastDiagAt < DIAG_THROTTLE_MS) return;
    lastDiagAt = now;
    console.log('[Ambient][diag]', snapshot(reason));
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
        diag('setGain-webaudio');
        return;
    }
    setElementVolume(next, durationMs);
    diag('setGain-element');
}

function ensureAudioGraph() {
    if (audioEl) return;

    audioEl = new Audio(AMBIENT_SRC);
    audioEl.loop = true;
    audioEl.preload = 'metadata';
    audioEl.volume = 0;
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('loadedmetadata', () => diag('media-loadedmetadata', true));
    audioEl.addEventListener('canplay', () => diag('media-canplay', true));
    audioEl.addEventListener('playing', () => diag('media-playing', true));
    audioEl.addEventListener('pause', () => diag('media-pause', true));
    audioEl.addEventListener('waiting', () => diag('media-waiting', true));
    audioEl.addEventListener('stalled', () => diag('media-stalled', true));
    audioEl.addEventListener('suspend', () => diag('media-suspend', true));
    audioEl.addEventListener('error', () => diag('media-error', true));

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
        warnPlayback('No AudioContext available; using element volume only.');
        diag('audio-graph-no-context', true);
        return;
    }

    try {
        audioCtx = new AudioCtx();
        sourceNode = audioCtx.createMediaElementSource(audioEl);
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 0;
        sourceNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        usingWebAudio = true;
        diag('audio-graph-ready', true);
    } catch {
        usingWebAudio = false;
        audioCtx = null;
        sourceNode = null;
        gainNode = null;
        warnPlayback('Failed to create WebAudio graph; using element volume only.');
        diag('audio-graph-fallback', true);
    }
}

function isSpeechActive() {
    return Boolean(STATE.speaking || smallSpeaking);
}

function computeTargetGain() {
    if (!active) return 0;
    let peak = isSpeechActive() ? DUCKED_GAIN : PEAK_GAIN;
    if (STATE.sleeping) peak *= SLEEP_GAIN_FACTOR;
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
    diag('ensurePlaybackReady:start', true);

    if (audioCtx && audioCtx.state === 'suspended') {
        try {
            await withTimeout(audioCtx.resume(), PLAY_PROMISE_TIMEOUT_MS, 'audioCtx.resume');
            diag('audioCtx-resumed', true);
        } catch (err) {
            warnPlayback('AudioContext resume blocked (waiting for gesture).', err);
            diag('audioCtx-resume-failed', true);
        }
    }

    if (audioEl.paused) {
        try {
            await withTimeout(audioEl.play(), PLAY_PROMISE_TIMEOUT_MS, 'audio.play');
            diag('audio-play-ok', true);
        } catch (err) {
            warnPlayback('Audio element play blocked (waiting for gesture).', err);
            diag('audio-play-failed', true);
        }
    }
    diag('ensurePlaybackReady:end', true);
}

function schedulePauseIfInactive() {
    clearPauseTimer();
    if (active || !audioEl) return;
    pauseTimer = setTimeout(() => {
        pauseTimer = null;
        if (active || !audioEl || audioEl.paused) return;
        audioEl.pause();
        diag('pause-idle', true);
    }, PAUSE_IDLE_DELAY_MS);
}

function setEnvelope(nextEnvelope, durationMs) {
    envelope = clamp01(nextEnvelope);
    applyTargetGain(durationMs);
    diag('setEnvelope');
}

async function runPulseLoop(myToken) {
    while (initialized && myToken === pulseToken) {
        await sleep(PULSE_INTERVAL_MS);
        if (!initialized || myToken !== pulseToken || !active) return;

        setEnvelope(1, FADE_IN_MS);
        await sleep(FADE_IN_MS + HOLD_MS);
        if (!initialized || myToken !== pulseToken || !active) return;

        setEnvelope(BASE_ENVELOPE, FADE_OUT_MS);
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
    return STATE.ambientAudioEnabled !== false && !STATE.muted && !document.hidden;
}

function syncActiveState() {
    const nextActive = shouldBeActive();
    if (nextActive === active) {
        if (active) {
            applyTargetGain(140);
            const needsRecover = Boolean(audioEl && (audioEl.paused || (audioCtx && audioCtx.state !== 'running')));
            const now = Date.now();
            if (needsRecover && now - lastRecoveryAt >= PLAYBACK_RECOVERY_MS) {
                lastRecoveryAt = now;
                diag('syncActive-recover', true);
                void ensurePlaybackReady();
            }
        }
        diag('syncActive-steady');
        return;
    }

    active = nextActive;
    diag('syncActive-changed', true);
    if (active) {
        clearPauseTimer();
        void ensurePlaybackReady();
        setEnvelope(BASE_ENVELOPE, 300);
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
    diag('small-speech-observed', true);
}

function bindUnlockListeners() {
    const tryUnlock = (event) => {
        diag(`unlock-${event?.type || 'unknown'}`, true);
        void ensurePlaybackReady();
        if (active) applyTargetGain(120);
    };
    window.addEventListener('pointerdown', tryUnlock, { passive: true });
    window.addEventListener('mousedown', tryUnlock, { passive: true });
    window.addEventListener('touchstart', tryUnlock, { passive: true });
    window.addEventListener('keydown', tryUnlock);
    document.addEventListener('click', tryUnlock, true);
    document.addEventListener('pointerdown', tryUnlock, true);
    document.addEventListener('touchstart', tryUnlock, true);
    document.addEventListener('keydown', tryUnlock, true);
}

export function initAmbientAudio() {
    if (initialized) return;
    initialized = true;
    diag('init:start', true);

    ensureAudioGraph();
    if (audioEl) {
        try {
            audioEl.load();
            diag('audio-load-called', true);
        } catch {
            // no-op
            diag('audio-load-failed', true);
        }
    }

    bindUnlockListeners();
    window.addEventListener('tubs:head-speech-observed', handleSpeechObserved);
    document.addEventListener('visibilitychange', syncActiveState);

    syncActiveState();
    statePollTimer = setInterval(syncActiveState, STATE_POLL_MS);
    diag('init:done', true);
}
