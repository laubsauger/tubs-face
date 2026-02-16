import { STATE } from './state.js';
import { $, loadingBar, subtitleEl } from './dom.js';
import { setExpression, startSpeaking, stopSpeaking } from './expressions.js';
import { showDonationQr } from './donation-ui.js';
import { clearInterruptionTimer } from './audio-input.js';
import { suggestEmotionExpression } from './emotion-engine.js';
import { createSubtitleController } from './subtitles.js';
import { tryUnlockAmbientPlayback } from './ambient-audio.js';
import { inferDonationFromText, normalizeSpeechText } from './tts-text.js';
import { logTurnTiming, markTurn } from './turn-timing.js';

const INTER_UTTERANCE_PAUSE_MS = 220;
const POST_SPEECH_IDLE_DELAY_MS = 350;
const REACTION_PAUSE_MS = 420;
const REMOTE_SPEECH_STALE_MS = 20000;
const REMOTE_WAIT_POLL_MS = 90;
const REMOTE_WAIT_MAX_MS = 45000;
const SPEECH_SAFETY_MAX_MS = 60000;

const subtitles = createSubtitleController(subtitleEl);
let speechSafetyTimer = null;
let currentAudioElement = null;
let lastEmotion = null;
let remoteSmallSpeaking = false;
let remoteSmallSpeakingUntil = 0;
let remoteWaitTimer = null;

function shouldUseBrowserTtsFallback() {
    return String(STATE.ttsBackend || 'kokoro').trim().toLowerCase() === 'system';
}

function handleTtsFailure(item, err, reason = 'unknown') {
    const detail = err?.message || String(err || 'unknown');
    console.error(`[TTS] ${reason}: ${detail}`);
    clearSpeechSafety();
    stopSubtitles();

    if (shouldUseBrowserTtsFallback()) {
        speakFallback(item);
        return;
    }

    $('#stat-listen-state').textContent = 'TTS error';
    stopSpeaking();
    setExpression('idle', { force: true, skipHold: true });
    setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
}

function startSubtitles(text, source) {
    subtitles.start(text, source);
}

function stopSubtitles() {
    subtitles.stop();
}

function finishSubtitles() {
    subtitles.finish();
}

function clearSpeechSafety() {
    if (!speechSafetyTimer) return;
    clearTimeout(speechSafetyTimer);
    speechSafetyTimer = null;
}

function emitHeadSpeechState(state, turnId = null, durationMs = null) {
    const detail = {
        actor: 'main',
        state: state === 'end' ? 'end' : 'start',
        turnId: turnId || STATE.currentTurnId || null,
        ts: Date.now(),
    };
    if (durationMs != null && Number.isFinite(durationMs) && durationMs > 0) {
        detail.durationMs = Math.round(durationMs);
    }
    window.dispatchEvent(new CustomEvent('tubs:head-speech-state', { detail }));
}

function clearRemoteWaitTimer() {
    if (!remoteWaitTimer) return;
    clearTimeout(remoteWaitTimer);
    remoteWaitTimer = null;
}

function markRemoteSmallSpeaking(isSpeaking, ts = Date.now(), durationMs = null) {
    remoteSmallSpeaking = Boolean(isSpeaking);
    if (!remoteSmallSpeaking) {
        remoteSmallSpeakingUntil = 0;
        return;
    }
    // Use actual audio duration + buffer when available, otherwise fall back to stale timeout
    const PAD_MS = 500;
    const timeout = (durationMs != null && Number.isFinite(durationMs) && durationMs > 0)
        ? durationMs + PAD_MS
        : REMOTE_SPEECH_STALE_MS;
    remoteSmallSpeakingUntil = ts + timeout;
}

function isRemoteSmallSpeakingNow() {
    if (!remoteSmallSpeaking) return false;
    if (Date.now() > remoteSmallSpeakingUntil) {
        remoteSmallSpeaking = false;
        remoteSmallSpeakingUntil = 0;
        return false;
    }
    return true;
}

function shouldGateMainSpeech() {
    if (!STATE.dualHeadEnabled || STATE.dualHeadMode === 'off') return false;
    return isRemoteSmallSpeakingNow();
}

function isRemoteActorSpeaking(actor) {
    const actorKey = String(actor || '').toLowerCase();
    if (actorKey === 'small') return isRemoteSmallSpeakingNow();
    return false;
}

function waitForRemoteActor(item) {
    const remoteActor = item?.actor || 'small';
    const now = Date.now();
    if (!item._waitRemoteStartedAt) {
        item._waitRemoteStartedAt = now;
        item._waitRemoteSawStart = false;
    }

    const remoteSpeaking = isRemoteActorSpeaking(remoteActor);
    if (remoteSpeaking) {
        item._waitRemoteSawStart = true;
    }

    const elapsed = now - item._waitRemoteStartedAt;
    const timedOut = !item._waitRemoteSawStart && elapsed >= REMOTE_WAIT_MAX_MS;
    const done = (item._waitRemoteSawStart && !remoteSpeaking) || timedOut;
    if (timedOut) {
        console.warn('[TTS] wait_remote timed out waiting for remote start; advancing queue');
    }
    if (done) return true;

    STATE.ttsQueue.unshift(item);
    $('#stat-queue').textContent = STATE.ttsQueue.length;
    STATE.speaking = false;
    stopSpeaking();
    remoteWaitTimer = setTimeout(() => {
        remoteWaitTimer = null;
        processQueue();
    }, REMOTE_WAIT_POLL_MS);
    return false;
}

export function applyHeadSpeechState(msg) {
    const actor = String(msg?.actor || '').toLowerCase();
    if (actor !== 'small') return;
    const state = String(msg?.state || '').toLowerCase();
    if (state === 'start') {
        const durationMs = Number(msg?.durationMs) || null;
        markRemoteSmallSpeaking(true, Number(msg?.ts) || Date.now(), durationMs);
        return;
    }
    markRemoteSmallSpeaking(false, Number(msg?.ts) || Date.now());
    if (!STATE.speaking && STATE.ttsQueue.length > 0) {
        clearRemoteWaitTimer();
        setTimeout(() => processQueue(), 0);
    }
}

function startSpeechSafety() {
    clearSpeechSafety();
    speechSafetyTimer = setTimeout(() => {
        speechSafetyTimer = null;
        if (STATE.speaking) {
            console.warn('[TTS] Safety timeout - forcing queue advance');
            stopSubtitles();
            processQueue();
        }
    }, SPEECH_SAFETY_MAX_MS);
}

function pushQueueItem(item, autoStart = true) {
    STATE.ttsQueue.push(item);
    $('#stat-queue').textContent = STATE.ttsQueue.length;
    if (autoStart && !STATE.speaking) processQueue();
}

export function stopAllTTS() {
    console.log('[TTS] stopAllTTS - clearing queue and stopping playback');
    STATE.ttsQueue.length = 0;
    $('#stat-queue').textContent = '0';

    if (currentAudioElement) {
        currentAudioElement.oncanplaythrough = null;
        currentAudioElement.onerror = null;
        currentAudioElement.onended = null;
        currentAudioElement.pause();
        currentAudioElement.src = '';
        currentAudioElement = null;
    }

    speechSynthesis.cancel();

    clearSpeechSafety();
    clearRemoteWaitTimer();
    stopSubtitles();
    if (STATE.speaking) {
        emitHeadSpeechState('end');
    }
    STATE.speaking = false;
    STATE.speakingEndedAt = Date.now();
    stopSpeaking();
    loadingBar.classList.remove('active');
    $('#stat-listen-state').textContent = 'Idle';
    setExpression('listening');
}

export function enqueueSpeech(text, donation = null, emotion = null, turnId = null) {
    const normalizedText = normalizeSpeechText(text);
    if (!normalizedText) return '';

    console.log(`[TTS] Enqueue (${normalizedText.length} chars): ${normalizedText}`);

    const donationPayload = donation?.show ? donation : inferDonationFromText(normalizedText);
    if (donationPayload?.show) {
        showDonationQr(donationPayload);
    }

    pushQueueItem({
        action: 'speak',
        text: normalizedText,
        donation: donationPayload,
        emotion: emotion || null,
        turnId: turnId || STATE.currentTurnId || null,
    });

    return normalizedText;
}

export function enqueueTurnScript(beats = [], donation = null, turnId = null) {
    // Check server-supplied donation signal first
    let donationShown = false;
    if (donation?.show) {
        showDonationQr(donation);
        donationShown = true;
    }

    // Fallback: scan beat texts for donation keywords (in case server missed it)
    if (!donationShown && Array.isArray(beats)) {
        const allText = beats
            .filter(b => b?.action === 'speak' && b?.text)
            .map(b => b.text)
            .join(' ');
        const inferred = inferDonationFromText(allText);
        if (inferred?.show) {
            showDonationQr(inferred);
        }
    }

    if (!Array.isArray(beats) || beats.length === 0) return;

    for (const beat of beats) {
        const actionRaw = String(beat?.action || '').toLowerCase();
        const action = actionRaw === 'react'
            ? 'react'
            : actionRaw === 'wait_remote'
                ? 'wait_remote'
                : actionRaw === 'wait'
                    ? 'wait'
                    : 'speak';
        const emotion = beat?.emotion || null;
        const delayMs = Number(beat?.delayMs) || REACTION_PAUSE_MS;

        if (action === 'wait') {
            pushQueueItem({
                action: 'wait',
                delayMs: Math.max(120, delayMs),
                turnId: turnId || STATE.currentTurnId || null,
            }, false);
            continue;
        }

        if (action === 'react') {
            pushQueueItem({
                action: 'react',
                emotion,
                delayMs: Math.max(120, delayMs),
                turnId: turnId || STATE.currentTurnId || null,
            }, false);
            continue;
        }

        if (action === 'wait_remote') {
            pushQueueItem({
                action: 'wait_remote',
                actor: beat?.actor || 'small',
                turnId: turnId || STATE.currentTurnId || null,
            }, false);
            continue;
        }

        const text = normalizeSpeechText(beat?.text || '');
        if (!text) continue;

        pushQueueItem({
            action: 'speak',
            text,
            donation: null,
            emotion,
            turnId: turnId || STATE.currentTurnId || null,
        }, false);
    }

    $('#stat-queue').textContent = STATE.ttsQueue.length;
    if (!STATE.speaking) processQueue();
}

function handleReactionItem(item) {
    if (item.emotion?.expression) {
        setExpression(item.emotion.expression, { force: true });
    }
}

export function processQueue() {
    clearSpeechSafety();
    clearRemoteWaitTimer();

    if (STATE.ttsQueue.length === 0) {
        STATE.speaking = false;
        STATE.speakingEndedAt = Date.now();
        stopSubtitles();
        stopSpeaking();
        $('#stat-listen-state').textContent = 'Idle';

        if (lastEmotion?.expression) {
            suggestEmotionExpression(lastEmotion.expression);
        }
        lastEmotion = null;
        setTimeout(() => {
            if (!STATE.speaking) setExpression('idle');
        }, POST_SPEECH_IDLE_DELAY_MS);
        return;
    }

    // Stop any currently playing audio before starting the next item —
    // prevents two Audio elements from playing simultaneously
    if (currentAudioElement) {
        currentAudioElement.oncanplaythrough = null;
        currentAudioElement.onerror = null;
        currentAudioElement.onended = null;
        currentAudioElement.pause();
        currentAudioElement.src = '';
        currentAudioElement = null;
    }
    speechSynthesis.cancel();

    const item = STATE.ttsQueue.shift();
    $('#stat-queue').textContent = STATE.ttsQueue.length;

    if (item.action === 'speak' && shouldGateMainSpeech()) {
        STATE.ttsQueue.unshift(item);
        $('#stat-queue').textContent = STATE.ttsQueue.length;
        STATE.speaking = false;
        stopSpeaking();
        remoteWaitTimer = setTimeout(() => {
            remoteWaitTimer = null;
            processQueue();
        }, REMOTE_WAIT_POLL_MS);
        return;
    }

    STATE.speaking = true;
    STATE.lastActivity = Date.now();
    clearInterruptionTimer();

    if (item.action === 'wait') {
        stopSubtitles();
        stopSpeaking();
        setTimeout(() => processQueue(), Math.max(120, item.delayMs || REACTION_PAUSE_MS));
        return;
    }

    if (item.action === 'wait_remote') {
        stopSubtitles();
        stopSpeaking();
        STATE.speaking = false;
        if (waitForRemoteActor(item)) {
            setTimeout(() => processQueue(), 0);
        }
        return;
    }

    if (item.action === 'react') {
        handleReactionItem(item);
        setTimeout(() => processQueue(), Math.max(100, item.delayMs || REACTION_PAUSE_MS));
        return;
    }

    lastEmotion = item.emotion || null;
    if (item.emotion?.expression) {
        setExpression(item.emotion.expression, { force: true });
    }

    const itemTurnId = item.turnId || STATE.currentTurnId || null;
    if (item.action === 'speak' && itemTurnId) {
        markTurn(itemTurnId, 'Audio queued');
    }

    playTTS(item).catch(() => {
        clearSpeechSafety();
        STATE.speaking = false;
        processQueue();
    });
}

async function playTTS(item) {
    $('#stat-listen-state').textContent = 'Speaking...';
    const turnId = item.turnId || STATE.currentTurnId || null;

    try {
        let localSpeechActive = false;
        const markLocalSpeechStart = (durationMs = null) => {
            if (localSpeechActive) return;
            localSpeechActive = true;
            emitHeadSpeechState('start', STATE.currentTurnId, durationMs);
        };
        const markLocalSpeechEnd = () => {
            if (!localSpeechActive) return;
            localSpeechActive = false;
            emitHeadSpeechState('end', STATE.currentTurnId);
        };

        const res = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: item.text, voice: STATE.kokoroVoice })
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            const suffix = detail ? `: ${detail.slice(0, 240)}` : '';
            throw new Error(`TTS failed (${res.status})${suffix}`);
        }

        const blob = await res.blob();
        if (blob.size < 100) {
            throw new Error('TTS audio too small');
        }

        const audioURL = URL.createObjectURL(blob);
        const audio = new Audio();
        audio.src = audioURL;
        currentAudioElement = audio;

        function cleanup() {
            if (currentAudioElement === audio) currentAudioElement = null;
            URL.revokeObjectURL(audioURL);
        }

        let started = false;

        audio.oncanplaythrough = () => {
            if (started) return;
            started = true;

            startSubtitles(item.text, audio);
            startSpeaking();
            loadingBar.classList.remove('active');
            startSpeechSafety();

            audio.play().catch((e) => {
                markLocalSpeechEnd();
                cleanup();
                handleTtsFailure(item, e, 'audio.play failed');
            });
        };

        audio.onplay = () => {
            const durMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : null;
            markLocalSpeechStart(durMs);
            if (turnId) {
                markTurn(turnId, 'First audio played');
                markTurn(turnId, 'End-to-end response');
                logTurnTiming(turnId);
            }
            // TTS audio is playing — piggyback to unlock ambient audio
            tryUnlockAmbientPlayback();
        };

        audio.onerror = () => {
            markLocalSpeechEnd();
            cleanup();
            handleTtsFailure(item, new Error('audio playback error'), 'audio error');
        };

        audio.onended = () => {
            clearSpeechSafety();
            markLocalSpeechEnd();
            cleanup();
            finishSubtitles();
            stopSpeaking();
            if (turnId) {
                markTurn(turnId, 'Audio segment ended');
            }
            setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
        };
    } catch (e) {
        handleTtsFailure(item, e, 'request/play setup failed');
    }
}

function speakFallback(item) {
    console.log('[TTS] Using fallback speech synthesis');
    const wordCount = item.text.split(/\s+/).filter(Boolean).length;
    const estimatedDuration = wordCount * 0.35;

    startSpeaking();
    loadingBar.classList.remove('active');
    startSubtitles(item.text, estimatedDuration);

    const utterance = new SpeechSynthesisUtterance(item.text);
    const turnId = item.turnId || STATE.currentTurnId || null;
    let fallbackStarted = false;
    utterance.onstart = () => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        emitHeadSpeechState('start', STATE.currentTurnId, estimatedDuration * 1000);
        if (turnId) {
            markTurn(turnId, 'First audio played (fallback)');
            markTurn(turnId, 'End-to-end response');
            logTurnTiming(turnId);
        }
    };
    utterance.onend = () => {
        if (fallbackStarted) emitHeadSpeechState('end', STATE.currentTurnId);
        finishSubtitles();
        stopSpeaking();
        setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
    };
    utterance.onerror = () => {
        if (fallbackStarted) emitHeadSpeechState('end', STATE.currentTurnId);
        stopSubtitles();
        stopSpeaking();
        processQueue();
    };
    speechSynthesis.speak(utterance);
}
