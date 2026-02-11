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

// ── Subtitle helpers ──

const MAX_SEGMENT_CHARS = 36;
let subtitleTimer = null;

/** Split text into segments that fit within MAX_SEGMENT_CHARS, breaking on word boundaries. */
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

/** Render one segment's words into the subtitle element. */
function renderSegment(words) {
    subtitleEl.innerHTML = words.map(w => `<span class="word">${w}</span> `).join('');
    subtitleEl.classList.add('visible');
}

/**
 * Run the full subtitle sequence: show segments one at a time,
 * highlighting words within each segment in sync with audio duration.
 * @param {string} text  Full speech text
 * @param {number} duration  Total audio duration in seconds
 */
function startSubtitles(text, duration) {
    stopSubtitles();
    const segments = segmentText(text);
    const totalWords = segments.reduce((n, seg) => n + seg.length, 0);
    if (!totalWords) return;

    // Speed up slightly (0.9x) to ensure subtitles finish before audio 'onended' cuts them off
    const msPerWord = ((duration * 0.9) * 1000) / totalWords;
    let segIdx = 0;
    let wordIdx = 0;

    function showNextSegment() {
        if (segIdx >= segments.length) { stopSubtitles(); return; }
        const seg = segments[segIdx];
        renderSegment(seg);
        wordIdx = 0;
        highlightLoop(seg);
    }

    function highlightLoop(seg) {
        const wordEls = subtitleEl.querySelectorAll('.word');
        subtitleTimer = setInterval(() => {
            // mark previous word as spoken
            if (wordIdx > 0 && wordEls[wordIdx - 1]) {
                wordEls[wordIdx - 1].classList.remove('active');
                wordEls[wordIdx - 1].classList.add('spoken');
            }
            if (wordIdx < seg.length) {
                wordEls[wordIdx].classList.add('active');
                wordIdx++;
            } else {
                // segment done — advance
                clearInterval(subtitleTimer);
                subtitleTimer = null;
                segIdx++;
                showNextSegment();
            }
        }, msPerWord);
    }

    showNextSegment();
}

function stopSubtitles() {
    clearInterval(subtitleTimer);
    subtitleTimer = null;
    subtitleEl.classList.remove('visible');
}

// ── TTS queue ──

// Queue items: { text, donation, emotion }
let lastEmotion = null;

export function enqueueSpeech(text, donation = null, emotion = null) {
    const donationPayload = donation?.show ? donation : inferDonationFromText(text);
    if (donationPayload?.show) {
        showDonationQr(donationPayload);
    }
    STATE.ttsQueue.push({ text, donation: donationPayload, emotion });
    $('#stat-queue').textContent = STATE.ttsQueue.length;
    if (!STATE.speaking) processQueue();
}

export function processQueue() {
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

    // DON'T set 'speaking' yet — keep current expression (e.g. 'thinking')
    // DON'T remove loading bar yet — it'll be removed when audio starts

    lastEmotion = item.emotion || null;

    playTTS(item.text).catch(() => {
        STATE.speaking = false;
        processQueue();
    });
}

async function playTTS(text) {
    $('#stat-listen-state').textContent = 'Speaking...';

    const wordCount = text.split(/\s+/).filter(Boolean).length;

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

        audio.oncanplaythrough = () => {
            const dur = isFinite(audio.duration) ? audio.duration : wordCount * 0.15;
            startSubtitles(text, dur);

            // Start speaking mouth overlay — keeps current expression's eyes
            startSpeaking();
            loadingBar.classList.remove('active');

            audio.play().catch(e => {
                console.error("Audio play failed:", e);
                cleanup();
                stopSubtitles();
                processQueue();
            });
        };

        audio.onerror = (e) => {
            console.error("Audio load failed", e);
            cleanup();
            stopSubtitles();
            speakFallback(text);
        };

        audio.onended = () => {
            cleanup();
            stopSubtitles();
            // Brief pause between utterances for natural pacing
            setTimeout(() => processQueue(), INTER_UTTERANCE_PAUSE_MS);
        };

    } catch (e) {
        console.error("TTS Error:", e);
        stopSubtitles();
        speakFallback(text);
    }
}

function speakFallback(text) {
    console.log('[TTS] Using fallback speech synthesis');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const estimatedDuration = wordCount * 0.15;

    // Start speaking mouth overlay for fallback too
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
