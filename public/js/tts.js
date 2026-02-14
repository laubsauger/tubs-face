import { STATE } from './state.js';
import { $, loadingBar, subtitleEl } from './dom.js';
import { setExpression, startSpeaking, stopSpeaking } from './expressions.js';
import { showDonationQr } from './donation-ui.js';
import { clearInterruptionTimer } from './audio-input.js';
import { suggestEmotionExpression } from './emotion-engine.js';
import { createSubtitleController } from './subtitles.js';
import { tryUnlockAmbientPlayback } from './ambient-audio.js';

const DONATION_HINT_RE = /\b(venmo|paypal|cash\s*app|donat(?:e|ion|ions|ing)|fundrais(?:er|ing)|wheel(?:s|chair)?(?:\s+fund)?|qr\s*code|chip\s*in|contribut(?:e|ion)|spare\s*change|support\s+(?:me|tubs|the\s+fund)|sponsor|tip(?:s|ping)?|money|fund(?:s|ing|ed)?|beg(?:ging)?|please\s+(?:help|give|support)|give\s+(?:me\s+)?money|rapha|thailand|help\s+(?:me|tubs|out)|need(?:s)?\s+(?:your\s+)?(?:help|money|support|funds))\b/i;
const DONATION_MARKER_RE = /\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/gi;

const INTER_UTTERANCE_PAUSE_MS = 220;
const POST_SPEECH_IDLE_DELAY_MS = 350;
const REACTION_PAUSE_MS = 420;
const REMOTE_SPEECH_STALE_MS = 20000;
const REMOTE_WAIT_POLL_MS = 90;
const REMOTE_WAIT_TIMEOUT_PAD_MS = 5000;

const subtitles = createSubtitleController(subtitleEl);
let speechSafetyTimer = null;
let currentAudioElement = null;
let lastEmotion = null;
let remoteSmallSpeaking = false;
let remoteSmallSpeakingUntil = 0;
let remoteWaitTimer = null;

function inferDonationFromText(text) {
    if (!DONATION_HINT_RE.test(String(text || ''))) return null;
    return {
        show: true,
        reason: 'text_fallback',
        venmoHandle: 'tubs-wheel-fund',
    };
}

function normalizeSpeechText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(DONATION_MARKER_RE, ' ')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function startSubtitles(text, source) {
    subtitles.start(text, source);
}

function stopSubtitles() {
    subtitles.stop();
}

function clearSpeechSafety() {
    if (!speechSafetyTimer) return;
    clearTimeout(speechSafetyTimer);
    speechSafetyTimer = null;
}

function emitHeadSpeechState(state, turnId = null) {
    const detail = {
        actor: 'main',
        state: state === 'end' ? 'end' : 'start',
        turnId: turnId || STATE.currentTurnId || null,
        ts: Date.now(),
    };
    window.dispatchEvent(new CustomEvent('tubs:head-speech-state', { detail }));
}

function clearRemoteWaitTimer() {
    if (!remoteWaitTimer) return;
    clearTimeout(remoteWaitTimer);
    remoteWaitTimer = null;
}

function markRemoteSmallSpeaking(isSpeaking, ts = Date.now()) {
    remoteSmallSpeaking = Boolean(isSpeaking);
    remoteSmallSpeakingUntil = remoteSmallSpeaking ? (ts + REMOTE_SPEECH_STALE_MS) : 0;
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

    const timeoutMs = Math.max(1000, Number(item?.delayMs) || 0) + REMOTE_WAIT_TIMEOUT_PAD_MS;
    const elapsed = now - item._waitRemoteStartedAt;
    const done = (item._waitRemoteSawStart && !remoteSpeaking) || (!item._waitRemoteSawStart && elapsed >= timeoutMs);
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
        markRemoteSmallSpeaking(true, Number(msg?.ts) || Date.now());
        return;
    }
    markRemoteSmallSpeaking(false, Number(msg?.ts) || Date.now());
    if (!STATE.speaking && STATE.ttsQueue.length > 0) {
        clearRemoteWaitTimer();
        setTimeout(() => processQueue(), 0);
    }
}

function startSpeechSafety(durationMs) {
    clearSpeechSafety();
    speechSafetyTimer = setTimeout(() => {
        speechSafetyTimer = null;
        if (STATE.speaking) {
            console.warn('[TTS] Safety timeout - forcing queue advance');
            stopSubtitles();
            processQueue();
        }
    }, durationMs + 2000);
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

export function enqueueSpeech(text, donation = null, emotion = null) {
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
    });

    return normalizedText;
}

export function enqueueTurnScript(beats = [], donation = null) {
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
            }, false);
            continue;
        }

        if (action === 'react') {
            pushQueueItem({
                action: 'react',
                emotion,
                delayMs: Math.max(120, delayMs),
            }, false);
            continue;
        }

        if (action === 'wait_remote') {
            pushQueueItem({
                action: 'wait_remote',
                actor: beat?.actor || 'small',
                delayMs: Math.max(120, delayMs),
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
        }, false);
    }

    $('#stat-queue').textContent = STATE.ttsQueue.length;
    if (!STATE.speaking) processQueue();
}

function handleReactionItem(item) {
    if (item.emotion?.expression) {
        suggestEmotionExpression(item.emotion.expression);
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
            lastEmotion = null;
        } else {
            setTimeout(() => {
                if (!STATE.speaking) setExpression('idle');
            }, POST_SPEECH_IDLE_DELAY_MS);
        }
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

    playTTS(item).catch(() => {
        clearSpeechSafety();
        STATE.speaking = false;
        processQueue();
    });
}

async function playTTS(item) {
    $('#stat-listen-state').textContent = 'Speaking...';

    try {
        let localSpeechActive = false;
        const markLocalSpeechStart = () => {
            if (localSpeechActive) return;
            localSpeechActive = true;
            emitHeadSpeechState('start', STATE.currentTurnId);
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

        if (!res.ok) throw new Error('TTS Failed');

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

            const dur = isFinite(audio.duration) ? audio.duration : 0;
            startSubtitles(item.text, audio);
            startSpeaking();
            loadingBar.classList.remove('active');
            startSpeechSafety(dur > 0 ? dur * 1000 : 10000);

            audio.play().catch((e) => {
                console.error('[TTS] Audio play failed:', e);
                clearSpeechSafety();
                markLocalSpeechEnd();
                cleanup();
                stopSubtitles();
                processQueue();
            });
        };

        audio.onplay = () => {
            markLocalSpeechStart();
            // TTS audio is playing — piggyback to unlock ambient audio
            tryUnlockAmbientPlayback();
        };

        audio.onerror = () => {
            clearSpeechSafety();
            markLocalSpeechEnd();
            cleanup();
            stopSubtitles();
            speakFallback(item);
        };

        audio.onended = () => {
            clearSpeechSafety();
            markLocalSpeechEnd();
            cleanup();
            stopSubtitles();
            stopSpeaking();
            setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
        };
    } catch (e) {
        console.error('[TTS] Error:', e);
        clearSpeechSafety();
        stopSubtitles();
        speakFallback(item);
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
    let fallbackStarted = false;
    utterance.onstart = () => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        emitHeadSpeechState('start', STATE.currentTurnId);
    };
    utterance.onend = () => {
        if (fallbackStarted) emitHeadSpeechState('end', STATE.currentTurnId);
        stopSubtitles();
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
