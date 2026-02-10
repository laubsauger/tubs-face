import { STATE } from './state.js';
import { $, loadingBar, speechBubble } from './dom.js';
import { setExpression } from './expressions.js';
import { showDonationQr } from './donation-ui.js';

const DONATION_HINT_RE = /\b(venmo|donat(?:e|ion|ions|ing)|fundraiser|wheel fund|chip in|contribute|sponsor|qr code)\b/i;

function inferDonationFromText(text) {
    if (!DONATION_HINT_RE.test(String(text || ''))) return null;
    return {
        show: true,
        reason: 'text_fallback',
        venmoHandle: 'tubs-wheel-fund',
    };
}

export function enqueueSpeech(text, donation = null) {
    const donationPayload = donation?.show ? donation : inferDonationFromText(text);
    if (donationPayload?.show) {
        showDonationQr(donationPayload);
    }
    STATE.ttsQueue.push(text);
    $('#stat-queue').textContent = STATE.ttsQueue.length;
    if (!STATE.speaking) processQueue();
}

export function processQueue() {
    if (STATE.ttsQueue.length === 0) {
        STATE.speaking = false;
        setExpression('idle');
        $('#stat-listen-state').textContent = 'Idle';
        speechBubble.classList.remove('visible');
        return;
    }

    const text = STATE.ttsQueue.shift();
    $('#stat-queue').textContent = STATE.ttsQueue.length;

    STATE.speaking = true;
    setExpression('speaking');

    speechBubble.textContent = text;
    speechBubble.classList.add('visible');
    loadingBar.classList.remove('active');

    playTTS(text).catch(() => {
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
            body: JSON.stringify({ text })
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

        audio.oncanplaythrough = () => {
            audio.play().catch(e => {
                console.error("Audio play failed:", e);
                processQueue();
            });
        };

        audio.onerror = (e) => {
            console.error("Audio load failed", e);
            speakFallback(text);
        };

        audio.onended = () => {
            processQueue();
            URL.revokeObjectURL(audioURL);
        };

    } catch (e) {
        console.error("TTS Error:", e);
        speakFallback(text);
    }
}

function speakFallback(text) {
    console.log('[TTS] Using fallback speech synthesis');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => processQueue();
    utterance.onerror = () => processQueue();
    speechSynthesis.speak(utterance);
}
