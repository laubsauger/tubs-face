import { STATE } from './state.js';
import { $, loadingBar } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression } from './expressions.js';
import { enqueueSpeech } from './tts.js';
import { hideDonationQr, showDonationQr } from './donation-ui.js';
import { enterSleep, exitSleep } from './sleep.js';
import { pushEmotionImpulse } from './emotion-engine.js';
import { setFaceRenderMode } from './face-renderer.js';
import { resetProactiveTimer } from './proactive.js';
import { updateWaveformMode } from './audio-input.js';

const NON_ACTIVITY_TYPES = new Set(['ping', 'stats', 'config']);
const JOY_LOCKED_EXPRESSIONS = new Set(['idle', 'listening', 'thinking']);
const DONATION_SIGNAL_MODES = new Set(['both', 'implied', 'confident', 'off']);
const DONATION_CONFIRM_RE = /\b(?:i(?:'ve| have| just)?\s*(?:sent|donated|paid|venmoed)|sent you|i got you|i did donate|donation sent|venmo sent|paid you)\b/i;
const DONATION_PLEDGE_RE = /\b(?:i(?:'ll| will| am going to| can)\s*(?:donate|send|venmo|pay|chip in|contribute|sponsor|give(?:\s+you)?\s+money)|take my money|i got you(?:\s+(?:today|tonight|later|tomorrow))?|i(?:'m| am)\s+down(?:\s+to)?\s+donate)\b/i;
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

function detectDonationSignal(text) {
    if (!text) return null;
    if (DONATION_CONFIRM_RE.test(text)) return 'confirmed';
    if (DONATION_PLEDGE_RE.test(text)) return 'pledge';
    return null;
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

function applyConfig(msg) {
    setSleepTimeoutMs(msg.sleepTimeout);
    setModel(msg.model);
    setDonationSignalMode(msg.donationSignalMode);
    setMinFaceBoxAreaRatio(msg.minFaceBoxAreaRatio);
    setRenderMode(msg.faceRenderMode);
    if (msg.vadNoiseGate != null) setNoiseGate(msg.vadNoiseGate);
    if (msg.kokoroVoice) setKokoroVoice(msg.kokoroVoice);
}

export function handleMessage(msg) {
    if (!NON_ACTIVITY_TYPES.has(msg.type)) {
        STATE.lastActivity = Date.now();
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
                const spokenText = enqueueSpeech(msg.text, msg.donation, msg.emotion || null);
                const emojiTag = msg.emotion?.emoji ? `${msg.emotion.emoji} ` : '';
                logChat('out', emojiTag + spokenText);
            }
            STATE.totalMessages++;
            resetProactiveTimer();
            break;
        case 'turn_start':
            STATE.currentTurnId = msg.turnId;
            break;
        case 'speak_chunk':
            // Ignore stale chunks from aborted turns
            if (msg.turnId && msg.turnId !== STATE.currentTurnId) break;
            console.log(`[MSG] speak_chunk #${msg.chunkIndex}: "${msg.text}"`);
            enqueueSpeech(msg.text, null, null);
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
            if (msg.emotion?.impulse) {
                pushEmotionImpulse(msg.emotion.impulse, 'spoken');
            }
            if (msg.donation?.show) {
                showDonationQr(msg.donation);
            }
            break;
        case 'backchannel':
            // Quick filler word while user is still speaking
            if (!STATE.speaking) {
                console.log(`[MSG] backchannel: "${msg.text}"`);
                enqueueSpeech(msg.text, null, null);
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
            enterSleep();
            break;
        case 'wake':
            exitSleep();
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
