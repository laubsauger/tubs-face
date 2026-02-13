import { STATE } from './state.js';
import {
    initFaceRenderer,
    setFaceRenderMode,
    setFaceRendererExpression,
    setFaceRendererSpeaking,
} from './face-renderer.js';
import { buildLocalTurnTimeline } from './turn-script.js';
import { lookAt, resetGaze } from './eye-tracking.js';
import { triggerBlink } from './expressions.js';
import { createSubtitleController } from './subtitles.js';
import { startIdleBehavior } from './idle-behavior.js';

const DONATION_MARKER_RE = /\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/gi;
const subtitleEl = document.getElementById('subtitle');
const reactionEl = document.getElementById('mini-reaction');
const subtitles = createSubtitleController(subtitleEl);

const INTER_UTTERANCE_PAUSE_MS = 200;
const REACTION_PAUSE_MS = 420;
const REMOTE_SPEECH_STALE_MS = 20000;
const REMOTE_WAIT_POLL_MS = 90;
const REMOTE_WAIT_TIMEOUT_PAD_MS = 1500;
const DUAL_FULLSCREEN_STORAGE_KEY = 'tubs.dualFullscreenDesired';
const MINI_FULLSCREEN_MESSAGE_TYPE = 'tubs-mini-fullscreen';

let ws = null;
let ttsQueue = [];
let speaking = false;
let currentAudio = null;
let currentTurnId = null;
let reactionTimer = null;
let remoteBlinkTimer = null;
let lastRemoteBlinkAt = 0;

let dualHeadEnabled = false;
let dualHeadMode = 'off';
let secondaryVoice = 'jf_tebukuro';
let secondaryAudioGain = 0.9;
let secondarySubtitleEnabled = false;
let miniSleeping = false;
let muted = false;
let currentExpression = 'idle';
let idleVariant = 'soft';
let mainHeadSpeaking = false;
let mainHeadSpeakingUntil = 0;
let mainSpeechWaitTimer = null;
let localSpeechActive = false;
let stopIdleBehavior = null;
let lastMainMotionAt = 0;
let desiredMiniFullscreen = false;
let pendingMiniFullscreen = false;

const REMOTE_BLINK_MIN_GAP_MS = 900;

function readDualFullscreenIntent() {
    try {
        return localStorage.getItem(DUAL_FULLSCREEN_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function isMiniFullscreenActive() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

async function requestMiniFullscreen() {
    const root = document.documentElement;
    if (root.requestFullscreen) {
        await root.requestFullscreen();
        return;
    }
    if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
        return;
    }
    throw new Error('Fullscreen API unavailable');
}

async function exitMiniFullscreen() {
    if (document.exitFullscreen) {
        await document.exitFullscreen();
        return;
    }
    if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
        return;
    }
    throw new Error('Fullscreen API unavailable');
}

async function applyMiniFullscreenIntent(reason = 'sync') {
    const active = isMiniFullscreenActive();
    if (desiredMiniFullscreen === active) {
        pendingMiniFullscreen = false;
        return;
    }

    if (!desiredMiniFullscreen) {
        pendingMiniFullscreen = false;
        try {
            await exitMiniFullscreen();
        } catch {
            // ignore
        }
        return;
    }

    try {
        await requestMiniFullscreen();
        pendingMiniFullscreen = false;
    } catch (err) {
        pendingMiniFullscreen = true;
        console.log(`[MINI] fullscreen deferred (${reason}): ${err?.message || 'request failed'}`);
    }
}

function initMiniFullscreenSync() {
    desiredMiniFullscreen = readDualFullscreenIntent();

    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const msg = event?.data;
        if (!msg || msg.type !== MINI_FULLSCREEN_MESSAGE_TYPE) return;
        desiredMiniFullscreen = Boolean(msg.enabled);
        void applyMiniFullscreenIntent('postMessage');
    });

    window.addEventListener('storage', (event) => {
        if (event.key !== DUAL_FULLSCREEN_STORAGE_KEY) return;
        desiredMiniFullscreen = readDualFullscreenIntent();
        void applyMiniFullscreenIntent('storage');
    });

    const retryIfPending = () => {
        if (!pendingMiniFullscreen || !desiredMiniFullscreen) return;
        void applyMiniFullscreenIntent('gesture');
    };

    window.addEventListener('pointerdown', retryIfPending, { passive: true });
    window.addEventListener('keydown', retryIfPending);
    window.addEventListener('focus', retryIfPending);

    document.addEventListener('fullscreenchange', () => {
        if (desiredMiniFullscreen && !isMiniFullscreenActive()) {
            pendingMiniFullscreen = true;
        }
    });
    document.addEventListener('webkitfullscreenchange', () => {
        if (desiredMiniFullscreen && !isMiniFullscreenActive()) {
            pendingMiniFullscreen = true;
        }
    });

    if (desiredMiniFullscreen) {
        setTimeout(() => {
            void applyMiniFullscreenIntent('init');
        }, 120);
    }
}

function summarizeTurnBeat(beat, index) {
    const actor = String(beat?.actor || 'main');
    const action = String(beat?.action || 'speak');
    const emoji = beat?.emotion?.emoji || '-';
    const text = String(beat?.text || '').replace(/\s+/g, ' ').trim();
    const preview = text.length > 56 ? `${text.slice(0, 56)}...` : text;
    return `${index}:${actor}/${action}/${emoji}${preview ? ` "${preview}"` : ''}`;
}

function summarizeTurnScript(beats) {
    if (!Array.isArray(beats) || beats.length === 0) return '[none]';
    return beats.map((beat, idx) => summarizeTurnBeat(beat, idx)).join(' | ');
}

function clampGain(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0.9;
    return Math.max(0, Math.min(1, parsed));
}

function normalizeText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(DONATION_MARKER_RE, ' ')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function clearReactionTimer() {
    if (!reactionTimer) return;
    clearTimeout(reactionTimer);
    reactionTimer = null;
}

function clearRemoteBlinkTimer() {
    if (!remoteBlinkTimer) return;
    clearTimeout(remoteBlinkTimer);
    remoteBlinkTimer = null;
}

function sendHeadSpeechState(state) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({
        type: 'head_speech_state',
        actor: 'small',
        state: state === 'end' ? 'end' : 'start',
        turnId: currentTurnId || null,
        ts: Date.now(),
    }));
}

function markLocalSpeechStart() {
    if (localSpeechActive) return;
    localSpeechActive = true;
    sendHeadSpeechState('start');
}

function markLocalSpeechEnd() {
    if (!localSpeechActive) return;
    localSpeechActive = false;
    sendHeadSpeechState('end');
}

function clearMainSpeechWaitTimer() {
    if (!mainSpeechWaitTimer) return;
    clearTimeout(mainSpeechWaitTimer);
    mainSpeechWaitTimer = null;
}

function markMainHeadSpeaking(isSpeaking, ts = Date.now()) {
    mainHeadSpeaking = Boolean(isSpeaking);
    mainHeadSpeakingUntil = mainHeadSpeaking ? (ts + REMOTE_SPEECH_STALE_MS) : 0;
}

function isMainHeadSpeakingNow() {
    if (!mainHeadSpeaking) return false;
    if (Date.now() > mainHeadSpeakingUntil) {
        mainHeadSpeaking = false;
        mainHeadSpeakingUntil = 0;
        return false;
    }
    return true;
}

function shouldGateSmallSpeech() {
    if (!dualHeadEnabled || dualHeadMode === 'off') return false;
    return isMainHeadSpeakingNow();
}

function isRemoteActorSpeaking(actor) {
    const actorKey = String(actor || '').toLowerCase();
    if (actorKey === 'main') return isMainHeadSpeakingNow();
    return false;
}

function waitForRemoteActor(item) {
    const remoteActor = item?.actor || 'main';
    const now = Date.now();
    if (!item._waitRemoteStartedAt) {
        item._waitRemoteStartedAt = now;
        item._waitRemoteSawStart = false;
    }

    const remoteSpeaking = isRemoteActorSpeaking(remoteActor);
    if (remoteSpeaking) {
        item._waitRemoteSawStart = true;
    }

    const timeoutMs = Math.max(1000, Number(item?.delayMs) || 0) + REMOTE_WAIT_TIMEOUT_PAD_MS;
    const elapsed = now - item._waitRemoteStartedAt;
    const done = (item._waitRemoteSawStart && !remoteSpeaking) || (!item._waitRemoteSawStart && elapsed >= timeoutMs);
    if (done) return true;

    ttsQueue.unshift(item);
    speaking = false;
    setFaceRendererSpeaking(false);
    mainSpeechWaitTimer = setTimeout(() => {
        mainSpeechWaitTimer = null;
        processQueue();
    }, REMOTE_WAIT_POLL_MS);
    return false;
}

function scheduleRemoteBlink() {
    const now = Date.now();
    if (now - lastRemoteBlinkAt < REMOTE_BLINK_MIN_GAP_MS) return;

    // Drop some relayed blinks so two heads do not lockstep.
    if (Math.random() < 0.35) return;

    clearRemoteBlinkTimer();
    const jitterMs = 90 + Math.floor(Math.random() * 330);
    remoteBlinkTimer = setTimeout(() => {
        remoteBlinkTimer = null;
        lastRemoteBlinkAt = Date.now();
        triggerBlink();
    }, jitterMs);
}

function pulseReaction(emoji = '') {
    if (!reactionEl || !emoji) return;
    clearReactionTimer();
    reactionEl.textContent = emoji;
    reactionEl.classList.add('visible');
    reactionTimer = setTimeout(() => {
        reactionTimer = null;
        reactionEl.classList.remove('visible');
    }, 1100);
}

function setMiniExpression(expr) {
    currentExpression = String(expr || 'idle');
    STATE.expression = currentExpression;
    if (currentExpression === 'idle') {
        setFaceRendererExpression(idleVariant === 'flat' ? 'idle-flat' : 'idle');
        return;
    }
    setFaceRendererExpression(currentExpression);
}

function miniResetGaze() {
    resetGaze();
}

function setMiniIdleVariant(nextVariant) {
    idleVariant = nextVariant === 'flat' ? 'flat' : 'soft';
    if (currentExpression === 'idle') {
        setFaceRendererExpression(idleVariant === 'flat' ? 'idle-flat' : 'idle');
    }
}

function initMiniIdleBehavior() {
    if (typeof stopIdleBehavior === 'function') return;
    stopIdleBehavior = startIdleBehavior({
        isSleeping: () => miniSleeping,
        isSpeaking: () => speaking,
        getExpression: () => currentExpression,
        setExpression: (expr) => setMiniExpression(expr),
        setIdleVariant: (variant) => setMiniIdleVariant(variant),
        blink: () => triggerBlink(),
        lookAt,
        resetGaze,
        canLookAround: () => (Date.now() - lastMainMotionAt) > 1800,
    });
}

function showSubtitle(text) {
    if (!secondarySubtitleEnabled) {
        hideSubtitle();
        return;
    }
    subtitles.start(text);
}

function hideSubtitle() {
    subtitles.stop();
}

function pushBeat(beat, autoStart = true) {
    ttsQueue.push(beat);
    if (autoStart && !speaking) processQueue();
}

function stopCurrentAudio() {
    if (!currentAudio) return;
    currentAudio.oncanplaythrough = null;
    currentAudio.onerror = null;
    currentAudio.onended = null;
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
}

function stopAll() {
    ttsQueue.length = 0;
    speaking = false;
    clearRemoteBlinkTimer();
    clearMainSpeechWaitTimer();
    stopCurrentAudio();
    speechSynthesis.cancel();
    markLocalSpeechEnd();
    setFaceRendererSpeaking(false);
    hideSubtitle();
}

function enqueueSmallBeats(beats) {
    const source = Array.isArray(beats) ? beats : [];
    const hasSpeakBeat = source.some((beat) => {
        if (!beat || typeof beat !== 'object') return false;
        if (String(beat.action || '').toLowerCase() !== 'speak') return false;
        return Boolean(normalizeText(beat.text || ''));
    });
    let promotedReactToSpeak = false;

    for (const beat of source) {
        if (!beat || typeof beat !== 'object') continue;
        const actionRaw = String(beat.action || '').toLowerCase();
        const action = actionRaw === 'react'
            ? 'react'
            : actionRaw === 'wait_remote'
                ? 'wait_remote'
                : actionRaw === 'wait'
                    ? 'wait'
                    : 'speak';
        const emotion = beat.emotion || null;
        const delayMs = Number(beat.delayMs) || REACTION_PAUSE_MS;

        if (action === 'wait') {
            pushBeat({
                action: 'wait',
                delayMs: Math.max(120, delayMs),
            }, false);
            continue;
        }

        if (action === 'react') {
            const reactText = normalizeText(beat.text || '');
            if (!hasSpeakBeat && reactText && !promotedReactToSpeak) {
                promotedReactToSpeak = true;
                console.log(`[MINI] promoting text react to speak (safety net): "${reactText.slice(0, 80)}"`);
                pushBeat({
                    action: 'speak',
                    text: reactText,
                    emotion,
                }, false);
                continue;
            }
            pushBeat({
                action,
                emotion,
                text: reactText,
                delayMs: Math.max(120, delayMs),
            }, false);
            continue;
        }

        if (action === 'wait_remote') {
            pushBeat({
                action: 'wait_remote',
                actor: beat.actor || 'main',
                delayMs: Math.max(120, delayMs),
            }, false);
            continue;
        }

        const text = normalizeText(beat.text || '');
        if (!text) continue;

        pushBeat({
            action: 'speak',
            text,
            emotion,
        }, false);
    }

    if (!speaking) processQueue();
}

function handleReactionBeat(item) {
    if (item.emotion?.expression) {
        setMiniExpression(item.emotion.expression);
    }
    if (item.emotion?.emoji) {
        pulseReaction(item.emotion.emoji);
    }
    if (item.text) {
        if (secondarySubtitleEnabled) {
            subtitles.start(item.text, Math.max(450, item.delayMs || REACTION_PAUSE_MS) / 1000);
        } else {
            hideSubtitle();
        }
    }
}

function processQueue() {
    clearMainSpeechWaitTimer();

    if (ttsQueue.length === 0) {
        speaking = false;
        setFaceRendererSpeaking(false);
        setMiniExpression('idle');
        hideSubtitle();
        return;
    }

    const item = ttsQueue.shift();
    console.log(`[MINI] queue item action=${item.action} textLen=${(item.text || '').length} delay=${item.delayMs || 0}`);

    if (item.action === 'speak' && shouldGateSmallSpeech()) {
        ttsQueue.unshift(item);
        speaking = false;
        setFaceRendererSpeaking(false);
        mainSpeechWaitTimer = setTimeout(() => {
            mainSpeechWaitTimer = null;
            processQueue();
        }, REMOTE_WAIT_POLL_MS);
        return;
    }

    if (item.action === 'wait') {
        speaking = true;
        setFaceRendererSpeaking(false);
        hideSubtitle();
        setTimeout(() => processQueue(), Math.max(120, item.delayMs || REACTION_PAUSE_MS));
        return;
    }

    if (item.action === 'wait_remote') {
        speaking = false;
        setFaceRendererSpeaking(false);
        hideSubtitle();
        if (waitForRemoteActor(item)) {
            setTimeout(() => processQueue(), 0);
        }
        return;
    }

    if (item.action === 'react') {
        speaking = true;
        handleReactionBeat(item);
        setTimeout(() => processQueue(), Math.max(120, item.delayMs || REACTION_PAUSE_MS));
        return;
    }

    speaking = true;
    playSpeakBeat(item).catch(() => {
        speaking = false;
        setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
    });
}

async function playSpeakBeat(item) {
    if (item.emotion?.expression) {
        setMiniExpression(item.emotion.expression);
    }
    if (item.emotion?.emoji) {
        pulseReaction(item.emotion.emoji);
    }

    hideSubtitle();
    setFaceRendererSpeaking(true);

    try {
        console.log(`[MINI] tts request voice=${secondaryVoice} chars=${(item.text || '').length}`);
        const res = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: item.text, voice: secondaryVoice })
        });
        if (!res.ok) throw new Error(`TTS failed: ${res.status}`);

        const blob = await res.blob();
        if (blob.size < 100) throw new Error('TTS audio too small');

        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        audio.volume = clampGain(secondaryAudioGain);
        currentAudio = audio;

        audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            if (currentAudio === audio) currentAudio = null;
            markLocalSpeechEnd();
            setFaceRendererSpeaking(false);
            hideSubtitle();
            speaking = false;
            setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
        };

        audio.onerror = () => {
            console.warn('[MINI] audio playback error, using speechSynthesis fallback');
            URL.revokeObjectURL(audioUrl);
            if (currentAudio === audio) currentAudio = null;
            markLocalSpeechEnd();
            setFaceRendererSpeaking(false);
            hideSubtitle();
            speaking = false;
            fallbackSpeak(item.text);
        };

        audio.onplay = () => {
            markLocalSpeechStart();
            if (secondarySubtitleEnabled) subtitles.start(item.text, audio);
        };

        await audio.play();
    } catch (err) {
        console.warn(`[MINI] tts/play failed (${err?.message || 'unknown'}), using speechSynthesis fallback`);
        markLocalSpeechEnd();
        setFaceRendererSpeaking(false);
        hideSubtitle();
        speaking = false;
        fallbackSpeak(item.text);
    }
}

function fallbackSpeak(text) {
    const wordCount = String(text || '').split(/\s+/).filter(Boolean).length;
    const estimatedDuration = wordCount * 0.35;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => {
        markLocalSpeechStart();
        if (secondarySubtitleEnabled) subtitles.start(text, estimatedDuration);
    };
    utterance.onend = () => {
        markLocalSpeechEnd();
        setFaceRendererSpeaking(false);
        hideSubtitle();
        setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
    };
    utterance.onerror = () => {
        markLocalSpeechEnd();
        setFaceRendererSpeaking(false);
        hideSubtitle();
        setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
    };
    speechSynthesis.speak(utterance);
}

function applyConfig(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, 'dualHeadEnabled')) {
        dualHeadEnabled = Boolean(msg.dualHeadEnabled);
    }
    if (msg.dualHeadMode) {
        dualHeadMode = String(msg.dualHeadMode);
    }
    if (msg.secondaryVoice) {
        secondaryVoice = String(msg.secondaryVoice);
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'secondaryAudioGain')) {
        secondaryAudioGain = clampGain(msg.secondaryAudioGain);
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'secondarySubtitleEnabled')) {
        secondarySubtitleEnabled = Boolean(msg.secondarySubtitleEnabled);
        if (!secondarySubtitleEnabled) hideSubtitle();
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'muted')) {
        muted = Boolean(msg.muted);
        if (muted) {
            stopAll();
            setMiniExpression('idle');
            miniResetGaze();
        }
    }
    console.log(`[MINI] config dualEnabled=${dualHeadEnabled} mode=${dualHeadMode} voice=${secondaryVoice} subtitles=${secondarySubtitleEnabled}`);
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'config':
            applyConfig(msg);
            break;
        case 'turn_start':
            currentTurnId = msg.turnId || null;
            stopAll();
            break;
        case 'turn_script': {
            if (muted) return;
            if (!dualHeadEnabled || dualHeadMode === 'off') {
                console.log(`[MINI] turn_script ignored (disabled/off) turn=${msg.turnId || 'n/a'} enabled=${dualHeadEnabled} mode=${dualHeadMode}`);
                return;
            }
            if (msg.turnId && currentTurnId && msg.turnId !== currentTurnId) {
                console.log(`[MINI] turn_script ignored (stale) turn=${msg.turnId} current=${currentTurnId}`);
                return;
            }
            console.log(`[MINI] turn_script turn=${msg.turnId || 'n/a'} raw=${summarizeTurnScript(msg.beats || [])}`);
            const timeline = buildLocalTurnTimeline(msg.beats || [], 'small');
            if (!timeline.length) {
                console.log(`[MINI] turn_script produced empty local timeline turn=${msg.turnId || 'n/a'}`);
                return;
            }
            console.log(`[MINI] local timeline turn=${msg.turnId || 'n/a'} ${summarizeTurnScript(timeline)}`);
            enqueueSmallBeats(timeline);
            break;
        }
        case 'head_speech_state': {
            if (muted) return;
            const actor = String(msg.actor || '').toLowerCase();
            if (actor !== 'main') return;
            const state = String(msg.state || '').toLowerCase();
            if (state === 'start') {
                markMainHeadSpeaking(true, Number(msg.ts) || Date.now());
                return;
            }
            markMainHeadSpeaking(false, Number(msg.ts) || Date.now());
            if (!speaking && ttsQueue.length > 0) {
                clearMainSpeechWaitTimer();
                setTimeout(() => processQueue(), 0);
            }
            return;
        }
        case 'face_motion':
            if (muted) return;
            if (!dualHeadEnabled || dualHeadMode === 'off') return;
            if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
            if (miniSleeping) return;
            lastMainMotionAt = Date.now();
            lookAt(msg.x, msg.y);
            break;
        case 'face_blink':
            if (muted) return;
            if (!dualHeadEnabled || dualHeadMode === 'off') return;
            if (miniSleeping) return;
            scheduleRemoteBlink();
            break;
        case 'speak_end':
            if (muted) return;
            if (!dualHeadEnabled || dualHeadMode !== 'mirror') return;
            if (msg.emotion) {
                enqueueSmallBeats([{ action: 'react', emotion: msg.emotion, delayMs: 520 }]);
            }
            break;
        case 'sleep':
            miniSleeping = true;
            document.body.classList.add('sleeping');
            setMiniExpression('sleep');
            miniResetGaze();
            stopAll();
            break;
        case 'wake':
            miniSleeping = false;
            document.body.classList.remove('sleeping');
            setMiniExpression('idle');
            miniResetGaze();
            break;
    }
}

function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        } catch {
            // ignore malformed events
        }
    };

    ws.onclose = () => {
        setTimeout(connectWs, 1500);
    };

    ws.onerror = () => {
        ws.close();
    };
}

function init() {
    STATE.faceRenderMode = 'svg';
    initMiniFullscreenSync();
    initFaceRenderer();
    setFaceRenderMode('svg', { persist: false });
    setMiniExpression('idle');
    miniResetGaze();
    initMiniIdleBehavior();
    connectWs();
}

init();
