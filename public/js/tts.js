import { STATE } from './state.js';
import { $, loadingBar, speechBubble, subtitleEl } from './dom.js';
import { setExpression, startSpeaking, stopSpeaking } from './expressions.js';
import { showDonationQr } from './donation-ui.js';
import { clearInterruptionTimer } from './audio-input.js';
import { suggestEmotionExpression } from './emotion-engine.js';

const DONATION_HINT_RE = /\b(venmo|paypal|cash\s*app|donat(?:e|ion|ions|ing)|fundrais(?:er|ing)|wheel(?:s|chair)?(?:\s+fund)?|qr\s*code|chip\s*in|contribut(?:e|ion)|spare\s*change|support\s+(?:me|tubs|the\s+fund)|sponsor|tip(?:s|ping)?|money|fund(?:s|ing|ed)?|beg(?:ging)?|please\s+(?:help|give|support)|give\s+(?:me\s+)?money|rapha|thailand|help\s+(?:me|tubs|out)|need(?:s)?\s+(?:your\s+)?(?:help|money|support|funds))\b/i;

const INTER_UTTERANCE_PAUSE_MS = 220;
const POST_SPEECH_IDLE_DELAY_MS = 350;

function inferDonationFromText(text) {
    if (!DONATION_HINT_RE.test(String(text || ''))) return null;
    return {
        show: true,
        reason: 'text_fallback',
        venmoHandle: 'tubs-wheel-fund',
    };
}

// ── Subtitle system ──

const MAX_SEGMENT_CHARS = 36;
let subtitleTimer = null;

function normalizeSpeechText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
let subtitleRafId = null;
let subtitleAudioRef = null;

function segmentText(text) {
    const words = text.split(/\s+/).filter(Boolean);
    const segments = [];
    let current = [];
    let len = 0;

    for (const w of words) {
        const added = len === 0 ? w.length : len + 1 + w.length;
        if (added > MAX_SEGMENT_CHARS && current.length > 0) {
            segments.push(current);
            current = [w];
            len = w.length;
        } else {
            current.push(w);
            len = added;
        }
    }
    if (current.length) segments.push(current);
    return segments;
}

function renderSegment(words) {
    subtitleEl.innerHTML = words.map(w => `<span class="word">${w}</span> `).join('');
    subtitleEl.classList.add('visible');
}

/**
 * Start subtitles synced to an audio element or a fixed duration.
 * @param {string} text  Full speech text
 * @param {HTMLAudioElement|number} source  Audio element (synced) or duration in seconds (interval-based)
 */
function startSubtitles(text, source) {
    stopSubtitles();
    const segments = segmentText(text);
    const totalWords = segments.reduce((n, seg) => n + seg.length, 0);
    if (!totalWords) return;

    // Build segment boundary map
    let cumWords = 0;
    const segBounds = segments.map(seg => {
        const start = cumWords;
        cumWords += seg.length;
        return { start, end: cumWords, words: seg };
    });

    let currentSegIdx = -1;
    let lastWordInSeg = -1;

    function updateHighlightTo(globalIdx) {
        // Find which segment this word belongs to
        let segIdx = 0;
        for (let i = 0; i < segBounds.length; i++) {
            if (globalIdx >= segBounds[i].start && globalIdx < segBounds[i].end) {
                segIdx = i;
                break;
            }
        }

        // Switch segment if needed
        if (segIdx !== currentSegIdx) {
            currentSegIdx = segIdx;
            renderSegment(segBounds[segIdx].words);
            lastWordInSeg = -1;
        }

        // Highlight up to target word in current segment
        const localIdx = globalIdx - segBounds[segIdx].start;
        if (localIdx > lastWordInSeg) {
            const wordEls = subtitleEl.querySelectorAll('.word');
            for (let i = lastWordInSeg + 1; i <= localIdx; i++) {
                if (i > 0 && wordEls[i - 1]) {
                    wordEls[i - 1].classList.remove('active');
                    wordEls[i - 1].classList.add('spoken');
                }
                if (wordEls[i]) wordEls[i].classList.add('active');
            }
            lastWordInSeg = localIdx;
        }
    }

    subtitleEl.classList.add('visible');

    if (source instanceof HTMLAudioElement && isFinite(source.duration) && source.duration > 0) {
        // Audio-synced mode: use requestAnimationFrame + audio.currentTime
        subtitleAudioRef = source;
        const duration = source.duration;

        // Show first segment immediately
        currentSegIdx = 0;
        renderSegment(segBounds[0].words);

        function tick() {
            if (!subtitleAudioRef || subtitleAudioRef.ended) return;

            const t = Math.min(subtitleAudioRef.currentTime / duration, 0.99);
            const globalIdx = Math.min(Math.floor(t * totalWords), totalWords - 1);
            if (globalIdx >= 0) updateHighlightTo(globalIdx);

            subtitleRafId = requestAnimationFrame(tick);
        }

        subtitleRafId = requestAnimationFrame(tick);
    } else {
        // Duration-based fallback (for SpeechSynthesis or unknown duration)
        const duration = (typeof source === 'number' && source > 0) ? source : totalWords * 0.35;
        const msPerWord = (duration * 0.85 * 1000) / totalWords;
        let flatIdx = 0;

        // Show first segment immediately
        currentSegIdx = 0;
        renderSegment(segBounds[0].words);

        subtitleTimer = setInterval(() => {
            if (flatIdx >= totalWords) {
                stopSubtitles();
                return;
            }
            updateHighlightTo(flatIdx);
            flatIdx++;
        }, msPerWord);
    }
}

function stopSubtitles() {
    if (subtitleRafId) {
        cancelAnimationFrame(subtitleRafId);
        subtitleRafId = null;
    }
    subtitleAudioRef = null;
    clearInterval(subtitleTimer);
    subtitleTimer = null;
    subtitleEl.classList.remove('visible');
}

// ── Speech safety timeout ──

let speechSafetyTimer = null;

function clearSpeechSafety() {
    if (speechSafetyTimer) {
        clearTimeout(speechSafetyTimer);
        speechSafetyTimer = null;
    }
}

function startSpeechSafety(durationMs) {
    clearSpeechSafety();
    // If audio doesn't end naturally, force-advance the queue
    speechSafetyTimer = setTimeout(() => {
        speechSafetyTimer = null;
        if (STATE.speaking) {
            console.warn('[TTS] Safety timeout — audio did not end, forcing advance');
            stopSubtitles();
            processQueue();
        }
    }, durationMs + 2000);
}

// ── TTS queue ──

let lastEmotion = null;

export function enqueueSpeech(text, donation = null, emotion = null) {
    const normalizedText = normalizeSpeechText(text);
    console.log(`[TTS] Enqueue (${normalizedText.length} chars): ${normalizedText}`);
    const donationPayload = donation?.show ? donation : inferDonationFromText(normalizedText);
    if (donationPayload?.show) {
        showDonationQr(donationPayload);
    }
    STATE.ttsQueue.push({ text: normalizedText, donation: donationPayload, emotion });
    $('#stat-queue').textContent = STATE.ttsQueue.length;
    if (!STATE.speaking) processQueue();
    return normalizedText;
}

export function processQueue() {
    clearSpeechSafety();

    if (STATE.ttsQueue.length === 0) {
        STATE.speaking = false;
        STATE.speakingEndedAt = Date.now();
        speechBubble.classList.remove('visible');
        stopSubtitles();
        stopSpeaking();
        $('#stat-listen-state').textContent = 'Idle';

        // Post-speech: pulse emotion expression if available, then idle
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

    const item = STATE.ttsQueue.shift();
    $('#stat-queue').textContent = STATE.ttsQueue.length;

    STATE.speaking = true;
    clearInterruptionTimer();

    // Show speech bubble immediately (visual feedback)
    speechBubble.textContent = item.text;
    speechBubble.classList.add('visible');

    lastEmotion = item.emotion || null;

    playTTS(item.text).catch(() => {
        clearSpeechSafety();
        STATE.speaking = false;
        processQueue();
    });
}

async function playTTS(text) {
    $('#stat-listen-state').textContent = 'Speaking...';

    try {
        const res = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: STATE.kokoroVoice })
        });

        if (!res.ok) throw new Error('TTS Failed');

        const blob = await res.blob();

        console.log(`[TTS] Received blob size: ${blob.size}, type: ${blob.type}`);

        if (blob.size < 100) {
            throw new Error('TTS Audio too small (likely error)');
        }

        const audioURL = URL.createObjectURL(blob);
        const audio = new Audio();
        audio.src = audioURL;

        function cleanup() {
            URL.revokeObjectURL(audioURL);
        }

        // Guard: only process canplaythrough once
        let started = false;

        audio.oncanplaythrough = () => {
            if (started) return;
            started = true;

            const dur = isFinite(audio.duration) ? audio.duration : 0;

            // Sync subtitles to the actual audio element
            startSubtitles(text, audio);

            // Start speaking mouth overlay
            startSpeaking();
            loadingBar.classList.remove('active');

            // Safety timeout in case onended doesn't fire
            startSpeechSafety(dur > 0 ? dur * 1000 : 10000);

            audio.play().catch(e => {
                console.error("Audio play failed:", e);
                clearSpeechSafety();
                cleanup();
                stopSubtitles();
                processQueue();
            });
        };

        audio.onerror = () => {
            clearSpeechSafety();
            cleanup();
            stopSubtitles();
            speakFallback(text);
        };

        audio.onended = () => {
            clearSpeechSafety();
            cleanup();
            stopSubtitles();
            setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
        };

    } catch (e) {
        console.error("TTS Error:", e);
        clearSpeechSafety();
        stopSubtitles();
        speakFallback(text);
    }
}

function speakFallback(text) {
    console.log('[TTS] Using fallback speech synthesis');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const estimatedDuration = wordCount * 0.35;

    startSpeaking();
    loadingBar.classList.remove('active');
    startSubtitles(text, estimatedDuration);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
        stopSubtitles();
        setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
    };
    utterance.onerror = () => {
        stopSubtitles();
        processQueue();
    };
    speechSynthesis.speak(utterance);
}
