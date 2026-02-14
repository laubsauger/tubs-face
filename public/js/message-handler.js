import { STATE } from './state.js';
import { $, loadingBar } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression } from './expressions.js';
import { enqueueSpeech, stopAllTTS, enqueueTurnScript, applyHeadSpeechState } from './tts.js';
import { hideDonationQr, showDonationQr } from './donation-ui.js';
import { enterSleep, exitSleep } from './sleep.js';
import { pushEmotionImpulse } from './emotion-engine.js';
import { setFaceRenderMode, setFaceRendererQuality } from './face-renderer.js';
import { enableGlitchFx, disableGlitchFx, setGlitchFxBaseColor } from './glitch-fx.js';
import { resetProactiveTimer } from './proactive.js';
import { updateWaveformMode, setInputMuted } from './audio-input.js';
import { buildLocalTurnTimeline } from './turn-script.js';
import { clearFaceVisionReactionsForMute } from './face/results.js';
import { perfMark } from './perf-hooks.js';
import { detectDonationSignal, summarizeTurnScript } from './message-handler-utils.js';
import { markTurn, onTurnStart } from './turn-timing.js';

const NON_ACTIVITY_TYPES = new Set(['ping', 'stats', 'config']);
const MUTED_ALLOWED_TYPES = new Set(['config', 'stats', 'ping', 'system', 'error', 'sleep', 'wake']);
const JOY_LOCKED_EXPRESSIONS = new Set(['idle', 'listening', 'thinking']);
const DONATION_SIGNAL_MODES = new Set(['both', 'implied', 'confident', 'off']);
const DONATION_JOY_DURATION_MS = 1800;

let donationJoyUntil = 0;
let donationJoyResetTimer = null;
let conversationExpireTimer = null;

function isDonationJoyActive(now = Date.now()) {
    return now < donationJoyUntil;
}

function setDonationSignalMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!DONATION_SIGNAL_MODES.has(normalized)) return;
    STATE.donationSignalMode = normalized;
}

function allowsImpliedDonationSignals() {
    return STATE.donationSignalMode === 'both' || STATE.donationSignalMode === 'implied';
}

function allowsConfidentDonationSignals() {
    return STATE.donationSignalMode === 'both' || STATE.donationSignalMode === 'confident';
}

function setModel(model) {
    if (!model) return;
    STATE.model = model;
    $('#stat-model').textContent = model;
}

function setSleepTimeoutMs(timeoutMs) {
    if (timeoutMs == null) return;
    STATE.sleepTimeout = timeoutMs;

    const secs = Math.round(timeoutMs / 1000);
    const slider = document.getElementById('sleep-timeout');
    const label = document.getElementById('sleep-timeout-val');
    if (slider) slider.value = secs;
    if (label) label.textContent = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
}

function setMinFaceBoxAreaRatio(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    STATE.minFaceBoxAreaRatio = Math.max(0, Math.min(0.2, parsed));
}

function setRenderMode(mode) {
    if (!mode) return;
    setFaceRenderMode(mode, { persist: false });
}

function setRenderQuality(value) {
    if (!value) return;
    const normalized = String(value).trim().toLowerCase();
    if (!['high', 'balanced', 'low'].includes(normalized)) return;
    STATE.renderQuality = normalized;
    setFaceRendererQuality(normalized);
    const select = document.getElementById('face-render-quality');
    if (select) select.value = normalized;
}

function setExpressionIfAllowed(expr) {
    if (isDonationJoyActive() && JOY_LOCKED_EXPRESSIONS.has(expr)) {
        return;
    }
    setExpression(expr);
}

function triggerDonationJoy() {
    donationJoyUntil = Date.now() + DONATION_JOY_DURATION_MS;
    setExpression('love');
    if (donationJoyResetTimer) {
        clearTimeout(donationJoyResetTimer);
    }
    donationJoyResetTimer = setTimeout(() => {
        donationJoyResetTimer = null;
        if (isDonationJoyActive()) return;
        if (STATE.expression === 'love' && !STATE.speaking) {
            setExpression('idle');
        }
    }, DONATION_JOY_DURATION_MS + 120);
}

function applyDonationSignal(signal) {
    if (!signal) return false;
    const certainty = signal.certainty === 'confident' ? 'confident' : 'implied';
    if (certainty === 'confident' && !allowsConfidentDonationSignals()) return false;
    if (certainty === 'implied' && !allowsImpliedDonationSignals()) return false;

    STATE.lastDonationSignalAt = signal.ts || Date.now();
    if (certainty === 'confident') {
        pushEmotionImpulse({ pos: 1, neg: 0, arousal: 0.85 }, 'system');
    } else {
        pushEmotionImpulse({ pos: 0.72, neg: 0, arousal: 0.65 }, 'system');
    }
    triggerDonationJoy();
    if (certainty === 'confident') {
        logChat('sys', `Donation confirmed (${signal.source || 'unknown'}).`);
    } else {
        logChat('sys', `Donation signal detected (${signal.source || 'implied'}).`);
    }
    return true;
}

function applyStats(msg) {
    if (msg.latency != null) {
        $('#stat-resp-time').textContent = `${msg.latency} ms`;
    }

    if (msg.tokens) {
        if (msg.totals) {
            STATE.tokensIn = msg.totals.in ?? STATE.tokensIn;
            STATE.tokensOut = msg.totals.out ?? STATE.tokensOut;
        } else {
            STATE.tokensIn += msg.tokens.in || 0;
            STATE.tokensOut += msg.tokens.out || 0;
        }
        $('#stat-tok-in').textContent = STATE.tokensIn;
        $('#stat-tok-out').textContent = STATE.tokensOut;
    }

    if (msg.cost != null) {
        if (msg.totals && msg.totals.cost != null) {
            STATE.totalCost = msg.totals.cost;
        } else {
            STATE.totalCost += msg.cost;
        }
        const precision = STATE.totalCost >= 1 ? 2 : 4;
        $('#stat-cost').textContent = `$${STATE.totalCost.toFixed(precision)}`;
    }

    setModel(msg.model);
}

function setNoiseGate(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    STATE.vadNoiseGate = Math.max(0, Math.min(0.06, parsed));
    const slider = document.getElementById('noise-gate');
    const label = document.getElementById('noise-gate-val');
    if (slider) slider.value = STATE.vadNoiseGate;
    if (label) label.textContent = STATE.vadNoiseGate.toFixed(3);
}

function setKokoroVoice(value) {
    if (!value) return;
    STATE.kokoroVoice = value;
    const select = document.getElementById('tts-voice');
    if (select) select.value = value;
}

function setSecondaryVoice(value) {
    if (!value) return;
    STATE.secondaryVoice = value;
    const select = document.getElementById('secondary-tts-voice');
    if (select) select.value = value;
}

function setSecondaryRenderQuality(value) {
    if (!value) return;
    const normalized = String(value).trim().toLowerCase();
    if (!['high', 'balanced', 'low'].includes(normalized)) return;
    STATE.secondaryRenderQuality = normalized;
    const select = document.getElementById('secondary-render-quality');
    if (select) select.value = normalized;
}

function setDualHeadEnabled(value) {
    STATE.dualHeadEnabled = Boolean(value);
    const toggle = document.getElementById('dual-head-enabled');
    if (toggle) toggle.checked = STATE.dualHeadEnabled;
}

function setDualHeadMode(value) {
    if (!value) return;
    STATE.dualHeadMode = value;
    const select = document.getElementById('dual-head-mode');
    if (select) select.value = value;
}

function setDualHeadTurnPolicy(value) {
    if (!value) return;
    STATE.dualHeadTurnPolicy = value;
    const select = document.getElementById('dual-head-turn-policy');
    if (select) select.value = value;
}

function setSecondarySubtitleEnabled(value) {
    STATE.secondarySubtitleEnabled = Boolean(value);
    const toggle = document.getElementById('secondary-subtitle-enabled');
    if (toggle) toggle.checked = STATE.secondarySubtitleEnabled;
}

function setSecondaryAudioGain(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    STATE.secondaryAudioGain = Math.max(0, Math.min(1.2, parsed));
    const slider = document.getElementById('secondary-audio-gain');
    const label = document.getElementById('secondary-audio-gain-val');
    if (slider) slider.value = String(STATE.secondaryAudioGain);
    if (label) label.textContent = STATE.secondaryAudioGain.toFixed(2);
}

function setMuted(value) {
    const muted = Boolean(value);
    STATE.muted = muted;
    const toggle = document.getElementById('mute-toggle');
    if (toggle) toggle.checked = muted;
    setInputMuted(muted);
    if (!muted) {
        updateWaveformMode();
        return;
    }
    stopAllTTS();
    clearFaceVisionReactionsForMute();
    hideDonationQr();
    loadingBar.classList.remove('active');
    setExpression('idle', { force: true, skipHold: true });
}

function setAmbientAudioEnabled(value) {
    const enabled = Boolean(value);
    STATE.ambientAudioEnabled = enabled;
    const toggle = document.getElementById('ambient-audio-toggle');
    if (toggle) toggle.checked = enabled;
}

function applyConfig(msg) {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(msg, key);
    setSleepTimeoutMs(msg.sleepTimeout);
    setModel(msg.model);
    setDonationSignalMode(msg.donationSignalMode);
    setMinFaceBoxAreaRatio(msg.minFaceBoxAreaRatio);
    setRenderMode(msg.faceRenderMode);
    if (msg.renderQuality) setRenderQuality(msg.renderQuality);
    if (msg.vadNoiseGate != null) setNoiseGate(msg.vadNoiseGate);
    if (msg.kokoroVoice) setKokoroVoice(msg.kokoroVoice);
    if (hasOwn('dualHeadEnabled')) setDualHeadEnabled(msg.dualHeadEnabled);
    if (msg.dualHeadMode) setDualHeadMode(msg.dualHeadMode);
    if (msg.dualHeadTurnPolicy) setDualHeadTurnPolicy(msg.dualHeadTurnPolicy);
    if (msg.secondaryVoice) setSecondaryVoice(msg.secondaryVoice);
    if (msg.secondaryRenderQuality) setSecondaryRenderQuality(msg.secondaryRenderQuality);
    if (hasOwn('secondarySubtitleEnabled')) setSecondarySubtitleEnabled(msg.secondarySubtitleEnabled);
    if (hasOwn('secondaryAudioGain')) setSecondaryAudioGain(msg.secondaryAudioGain);
    if (hasOwn('muted')) setMuted(msg.muted);
    if (hasOwn('ambientAudioEnabled')) setAmbientAudioEnabled(msg.ambientAudioEnabled);
    if (hasOwn('glitchFxEnabled')) {
        const toggle = document.getElementById('glitch-fx-toggle');
        if (msg.glitchFxEnabled) {
            enableGlitchFx();
            if (toggle) toggle.checked = true;
        } else {
            disableGlitchFx();
            if (toggle) toggle.checked = false;
        }
    }
    if (msg.glitchFxBaseColor) {
        setGlitchFxBaseColor(msg.glitchFxBaseColor);
        STATE.glitchFxBaseColor = msg.glitchFxBaseColor;
        const picker = document.getElementById('glitch-fx-color');
        if (picker) picker.value = msg.glitchFxBaseColor;
    }
    if (msg.secondaryGlitchFxBaseColor) {
        const picker = document.getElementById('secondary-glitch-fx-color');
        if (picker) picker.value = msg.secondaryGlitchFxBaseColor;
    }
}

export function handleMessage(msg) {
    perfMark('ws_in');
    perfMark(`ws_${String(msg?.type || 'unknown')}`);
    if (!NON_ACTIVITY_TYPES.has(msg.type)) {
        STATE.lastActivity = Date.now();
    }

    if (STATE.muted) {
        if (!MUTED_ALLOWED_TYPES.has(msg.type)) {
            return;
        }
    }

    switch (msg.type) {
        case 'speak':
            console.log(`[MSG] Received speak (${msg.text?.length} chars):`, msg.text);
            if (msg.emotion?.impulse) {
                pushEmotionImpulse(msg.emotion.impulse, 'spoken');
            }
            // Emotion expression is passed through the TTS queue
            // and pulsed AFTER speech ends (not before/during)
            {
                const spokenText = enqueueSpeech(msg.text, msg.donation, msg.emotion || null, msg.turnId || null);
                const emojiTag = msg.emotion?.emoji ? `${msg.emotion.emoji} ` : '';
                logChat('out', emojiTag + spokenText);
            }
            STATE.totalMessages++;
            resetProactiveTimer();
            break;
        case 'turn_start':
            // New turn — flush any speech still queued from the previous turn
            if (STATE.currentTurnId && STATE.currentTurnId !== msg.turnId) {
                if (STATE.speaking || STATE.ttsQueue?.length > 0) {
                    console.log(`[MSG] New turn ${msg.turnId} — flushing stale speech from ${STATE.currentTurnId}`);
                    stopAllTTS();
                }
            }
            STATE.currentTurnId = msg.turnId;
            onTurnStart(msg.turnId);
            break;
        case 'turn_context':
            if (msg.turnId && msg.turnId !== STATE.currentTurnId) break;
            if (msg.turnId) {
                markTurn(msg.turnId, `Image attached: ${msg.imageAttached ? 'yes' : 'no'}`);
                markTurn(msg.turnId, `History context: ${msg.historyMessages || 0} msgs / ${msg.historyChars || 0} chars`);
                markTurn(msg.turnId, `LLM mode: ${msg.mode || 'text'}`);
            }
            break;
        case 'speak_chunk':
            // Ignore stale chunks from aborted turns
            if (msg.turnId && msg.turnId !== STATE.currentTurnId) break;
            console.log(`[MSG] speak_chunk #${msg.chunkIndex}: "${msg.text}"`);
            if (msg.turnId && msg.chunkIndex === 0) {
                markTurn(msg.turnId, 'LLM first token received');
            }
            enqueueSpeech(msg.text, null, null, msg.turnId || STATE.currentTurnId || null);
            if (msg.chunkIndex === 0) {
                logChat('out', msg.text);
            } else {
                logChat('out', msg.text);
            }
            STATE.totalMessages++;
            resetProactiveTimer();
            break;
        case 'speak_end':
            if (msg.turnId && msg.turnId !== STATE.currentTurnId) break;
            console.log(`[MSG] speak_end turnId=${msg.turnId}`);
            if (msg.turnId) {
                markTurn(msg.turnId, 'LLM response completed');
            }
            if (msg.emotion?.impulse) {
                pushEmotionImpulse(msg.emotion.impulse, 'spoken');
            }
            if (msg.donation?.show) {
                showDonationQr(msg.donation);
            }
            break;
        case 'head_speech_state':
            window.dispatchEvent(new CustomEvent('tubs:head-speech-observed', {
                detail: {
                    actor: String(msg?.actor || '').toLowerCase(),
                    state: String(msg?.state || '').toLowerCase() === 'end' ? 'end' : 'start',
                    turnId: msg?.turnId || STATE.currentTurnId || null,
                    ts: Number(msg?.ts) || Date.now(),
                },
            }));
            applyHeadSpeechState(msg);
            break;
        case 'turn_script':
            if (msg.turnId && msg.turnId !== STATE.currentTurnId) break;
            console.log(`[MSG] turn_script turnId=${msg.turnId} beats=${msg.beats?.length || 0}`);
            if (msg.turnId) {
                markTurn(msg.turnId, 'Turn script received');
            }
            logChat('sys', `TURN ${msg.turnId || 'n/a'} ${summarizeTurnScript(msg.beats || [])}`);
            {
                const timeline = buildLocalTurnTimeline(msg.beats || [], 'main', {
                    includeRemoteWait: STATE.dualHeadEnabled && STATE.dualHeadMode !== 'off',
                });
                if (timeline.length === 0) break;
                enqueueTurnScript(timeline, msg.donation || null, msg.turnId || STATE.currentTurnId || null);
                for (const beat of timeline) {
                    if (beat?.action !== 'speak' || !beat?.text) continue;
                    const emojiTag = beat?.emotion?.emoji ? `${beat.emotion.emoji} ` : '';
                    logChat('out', emojiTag + beat.text);
                }
                STATE.totalMessages++;
                resetProactiveTimer();
            }
            break;
        case 'backchannel':
            // Quick filler word while user is still speaking
            if (!STATE.speaking) {
                console.log(`[MSG] backchannel: "${msg.text}"`);
                enqueueSpeech(msg.text, null, null, msg.turnId || null);
                // Brief nod expression
                setExpressionIfAllowed('smile');
                setTimeout(() => setExpressionIfAllowed('listening'), 800);
            }
            break;
        case 'incoming':
            console.log(`[MSG] incoming: "${msg.text}"`);
            {
                const donationSignal = detectDonationSignal(msg.text);
                if (donationSignal) {
                    applyDonationSignal({
                        certainty: 'implied',
                        source: `text-${donationSignal}`,
                        ts: Date.now(),
                    });
                }
            }
            logChat('in', msg.text);
            setExpressionIfAllowed('listening');
            resetProactiveTimer();
            break;
        case 'donation_signal':
            applyDonationSignal({
                certainty: msg.certainty,
                source: msg.source,
                ts: msg.ts,
            });
            break;
        case 'thinking':
            setExpressionIfAllowed('thinking');
            loadingBar.classList.add('active');
            break;
        case 'expression':
            setExpressionIfAllowed(msg.expression);
            break;
        case 'system':
            logChat('sys', msg.text);
            break;
        case 'error':
            logChat('sys', `ERROR: ${msg.text}`);
            loadingBar.classList.remove('active');
            setExpression('idle', { force: true, skipHold: true });
            break;
        case 'sleep':
            hideDonationQr();
            enterSleep({ sync: false });
            break;
        case 'wake':
            exitSleep({ sync: false });
            break;
        case 'stats':
            applyStats(msg);
            break;
        case 'config':
            applyConfig(msg);
            break;
        case 'conversation_mode':
            if (conversationExpireTimer) clearTimeout(conversationExpireTimer);
            if (msg.active) {
                STATE.inConversation = true;
                updateWaveformMode();
                // Auto-expire after the server's conversation window
                if (msg.expiresIn) {
                    conversationExpireTimer = setTimeout(() => {
                        STATE.inConversation = false;
                        updateWaveformMode();
                        conversationExpireTimer = null;
                    }, msg.expiresIn);
                }
            } else {
                STATE.inConversation = false;
                updateWaveformMode();
            }
            break;
    }
}
