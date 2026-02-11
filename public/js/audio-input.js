import { STATE } from './state.js';
import { $, pttIndicator, waveformContainer } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression } from './expressions.js';

let myvad = null;
let vadActive = false;
let isTranscribing = false;
let interruptionTimer = null;
let interruptionRecorder = null;
let interruptionChunks = [];
let interrupted = false;
// Chance to interrupt (0.0 - 1.0). 0.2 = 20% chance to set a short timer.
const INTERRUPTION_CHANCE = 0.3;
const SHORT_LIMIT_MS = 5000;  // Interrupt after 5s if active
const LONG_LIMIT_MS = 15000;  // Always interrupt after 15s (safety)

let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let micStream = null;
let micReady = false;
let visualizeRafId = null;
const ECHO_COOLDOWN_MS = 1500; // ignore mic input briefly after TTS ends

export function isVadActive() {
    return vadActive;
}

export async function initMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        logChat('sys', '⚠️ Mic unavailable — requires localhost or HTTPS');
        $('#stat-mic').textContent = 'Unavailable';
        $('#stat-mic').style.color = 'var(--error)';
        pttIndicator.textContent = '⚠ Mic requires localhost/HTTPS';
        pttIndicator.classList.add('mic-denied');
        return;
    }

    try {
        logChat('sys', 'Requesting microphone access...');
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(micStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        micReady = true;
        logChat('sys', '🎙️ Microphone ready — hold Space to talk');
        const statMic = $('#stat-mic');
        if (statMic) {
            statMic.textContent = 'Ready';
            statMic.style.color = 'var(--accent)';
        }
        if (pttIndicator) {
            pttIndicator.textContent = 'Hold Space to Talk';
            pttIndicator.classList.add('mic-ready');
        }
    } catch (err) {
        logChat('sys', `⚠️ Mic denied: ${err.message}`);
        const statMic = $('#stat-mic');
        if (statMic) {
            statMic.textContent = 'Denied';
            statMic.style.color = 'var(--error)';
        }
        if (pttIndicator) {
            pttIndicator.textContent = '⚠ Mic Access Denied';
            pttIndicator.classList.add('mic-denied');
        }
    }
}

export async function initVAD() {
    if (myvad) {
        console.log('[VAD] Already initialized, skipping.');
        return;
    }

    try {
        logChat('sys', 'Initializing VAD...');

        if (window.ort) {
            ort.env.logLevel = 'error';
        }

        myvad = await vad.MicVAD.new({
            onSpeechStart: () => {
                if (!vadActive || isTranscribing || STATE.speaking || STATE.sleeping) return;
                if (Date.now() - STATE.speakingEndedAt < ECHO_COOLDOWN_MS) return;
                console.log('Speech start detected');
                const statState = $('#stat-listen-state');
                if (statState) statState.textContent = 'Listening...';
                setExpression('listening');
                startInterruptionTimer();
            },
            onSpeechEnd: (audio) => {
                if (interrupted) {
                    console.log('Ignoring VAD speech end (already interrupted)');
                    interrupted = false;
                    return;
                }
                clearInterruptionTimer();
                if (!vadActive || isTranscribing || STATE.speaking || STATE.sleeping) return;
                if (Date.now() - STATE.speakingEndedAt < ECHO_COOLDOWN_MS) {
                    console.log('[VAD] Ignoring speech end — echo cooldown');
                    setExpression('idle');
                    return;
                }
                console.log('Speech end detected');
                processVadAudio(audio);
            },
            onVADMisfire: () => {
                clearInterruptionTimer();
                console.log('VAD Misfire');
                const statState = $('#stat-listen-state');
                if (statState) statState.textContent = 'Idle';
                setExpression('idle');
            },
            positiveSpeechThreshold: 0.6,
            minSpeechFrames: 4,
            redemptionFrames: 15,
            preSpeechPadFrames: 1,
            frameSamples: 1536
        });

        myvad.start();
        logChat('sys', 'VAD Ready');

    } catch (e) {
        console.error("VAD Init failed:", e);
        logChat('sys', '⚠️ VAD Init Failed');
    }
}

export function initVadToggle() {
    $('#vad-toggle').addEventListener('change', (e) => {
        vadActive = e.target.checked;
        if (vadActive) {
            logChat('sys', 'Always On: ENABLED');
            pttIndicator.textContent = 'Listening (Always On)';
            pttIndicator.classList.add('mic-ready');
            waveformContainer.classList.add('active');
            startVisualize();
        } else {
            logChat('sys', 'Always On: DISABLED');
            pttIndicator.textContent = 'Hold Space to Talk';
            waveformContainer.classList.remove('active');
            $('#stat-listen-state').textContent = 'Idle';
        }
    });
}

export function initNoiseGate() {
    const slider = document.getElementById('noise-gate');
    const label = document.getElementById('noise-gate-val');
    if (!slider) return;
    slider.value = STATE.vadNoiseGate;
    if (label) label.textContent = STATE.vadNoiseGate;
    slider.addEventListener('input', () => {
        STATE.vadNoiseGate = parseFloat(slider.value);
        if (label) label.textContent = STATE.vadNoiseGate.toFixed(3);
    });
}

function computeRMS(float32Array) {
    let sum = 0;
    for (let i = 0; i < float32Array.length; i++) {
        sum += float32Array[i] * float32Array[i];
    }
    return Math.sqrt(sum / float32Array.length);
}

async function processVadAudio(float32Array) {
    const rms = computeRMS(float32Array);
    const gate = STATE.vadNoiseGate || 0;

    if (rms < gate) {
        console.log(`[VAD] Below noise gate (RMS ${rms.toFixed(4)} < ${gate}) — discarding`);
        const statState = $('#stat-listen-state');
        if (statState) statState.textContent = 'Idle';
        setExpression('idle');
        return;
    }

    console.log(`[VAD] RMS ${rms.toFixed(4)} — sending`);
    const wavBlob = audioBufferToWav(float32Array);
    sendVoice(wavBlob, true);
}

function audioBufferToWav(float32Array) {
    const buffer = new ArrayBuffer(44 + float32Array.length * 2);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + float32Array.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, float32Array.length * 2, true);

    let offset = 44;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function startInterruptionTimer() {
    clearInterruptionTimer();
    interrupted = false;

    // Decide if we want to be "rude" (interrupt early) or just safe (interrupt very long speech)
    const isRude = Math.random() < INTERRUPTION_CHANCE;
    const limit = isRude ? (3000 + Math.random() * 4000) : LONG_LIMIT_MS; // 3-7s or 15s

    console.log(`[VAD] Starting interruption timer: ${Math.round(limit)}ms (Rude: ${isRude})`);

    // Start parallel recording
    if (micStream) {
        try {
            interruptionChunks = [];
            interruptionRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' });
            interruptionRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) interruptionChunks.push(e.data);
            };
            interruptionRecorder.onstop = () => {
                if (interrupted) {
                    const blob = new Blob(interruptionChunks, { type: 'audio/webm' });
                    console.log('[VAD] Interruption triggered! Sending audio...');
                    sendVoice(blob, true);

                    // Reset UI to indicate we stopped listening
                    $('#stat-listen-state').textContent = 'Interrupted!';
                    // Maybe trigger a specific expression?
                    setExpression('thinking');
                }
            };
            interruptionRecorder.start();
        } catch (e) {
            console.error('Failed to start interruption recorder:', e);
        }
    }

    interruptionTimer = setTimeout(() => {
        if (!vadActive || STATE.speaking) {
            // Tubs is talking — don't interrupt ourselves
            clearInterruptionTimer();
            return;
        }
        console.log('[VAD] Interruption timer fired!');
        interrupted = true;

        // Stop the recorder, which triggers onstop -> sendVoice
        if (interruptionRecorder && interruptionRecorder.state === 'recording') {
            interruptionRecorder.stop();
        }

    }, limit);
}

export function clearInterruptionTimer() {
    if (interruptionTimer) {
        clearTimeout(interruptionTimer);
        interruptionTimer = null;
    }
    if (interruptionRecorder) {
        if (interruptionRecorder.state === 'recording') {
            // Stop but don't trigger the "interrupted" logic in onstop
            // effectively discarding or just stopping cleanly
            interruptionRecorder.stop();
        }
        interruptionRecorder = null;
    }
}

export function initWaveformBars() {
    for (let i = 0; i < 20; i++) {
        const bar = document.createElement('div');
        bar.className = 'wave-bar';
        waveformContainer.appendChild(bar);
    }
}

export function startRecording() {
    console.log('[Audio] startRecording triggered', {
        recording: STATE.recording,
        sleeping: STATE.sleeping,
        micReady: micReady
    });
    if (STATE.recording || STATE.sleeping || !micReady) return;

    if (audioContext.state === 'suspended') audioContext.resume();

    audioChunks = [];
    mediaRecorder = new MediaRecorder(micStream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        sendVoice(blob);
    };

    mediaRecorder.start();
    STATE.recording = true;
    pttIndicator.textContent = '● Recording';
    pttIndicator.classList.remove('mic-ready');
    pttIndicator.classList.add('recording');
    waveformContainer.classList.add('active');
    $('#stat-mic').textContent = 'ON';
    $('#stat-mic').style.color = 'var(--accent)';
    $('#stat-input-src').textContent = 'Voice';
    $('#stat-listen-state').textContent = 'Recording';
    startVisualize();
}

export function stopRecording() {
    if (!STATE.recording) return;
    STATE.recording = false;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    pttIndicator.textContent = 'Hold Space to Talk';
    pttIndicator.classList.remove('recording');
    pttIndicator.classList.add('mic-ready');
    waveformContainer.classList.remove('active');
    $('#stat-mic').textContent = 'Ready';
    $('#stat-mic').style.color = '';
    $('#stat-listen-state').textContent = 'Processing';
}

function visualizeAudio() {
    visualizeRafId = null;
    if ((!STATE.recording && !vadActive) || !analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    const bars = waveformContainer.children;
    for (let i = 0; i < bars.length; i++) {
        const val = data[i] || 0;
        bars[i].style.height = `${Math.max(4, (val / 255) * 30)}px`;
    }

    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const volPct = Math.min(100, (avg / 128) * 100);
    const volBar = $('#stat-vol');
    if (volBar) volBar.style.width = `${volPct}%`;

    visualizeRafId = requestAnimationFrame(visualizeAudio);
}

function startVisualize() {
    if (visualizeRafId !== null) return;
    visualizeRafId = requestAnimationFrame(visualizeAudio);
}

async function sendVoice(blob, isVad = false) {
    if (!STATE.connected) {
        logChat('sys', 'Not connected — voice not sent');
        return;
    }

    isTranscribing = true;
    $('#stat-listen-state').textContent = 'Transcribing...';
    logChat('sys', 'Transcribing audio...');

    try {
        const url = isVad ? '/voice?wakeWord=true' : '/voice';

        const res = await fetch(url, {
            method: 'POST',
            body: blob,
            headers: {
                'Content-Type': 'audio/webm'
            }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        if (data.text) {
            const wakeInfo = data.wake
                ? ` [wake:${data.wake.version || 'unknown'} ${data.wake.reason || 'n/a'} ${data.wake.matchedSource || ''} ${data.wake.matchedToken || ''}]`
                : '';

            // Only log ignored messages or explicit debug info here.
            // Successful messages are broadcast back via WS as 'user_message' events.
            if (data.ignored) {
                const prefix = `[Ignored${wakeInfo}] `;
                logChat('sys', `${prefix}"${data.text}"`);
            }
        }

        if (data.ignored) {
            $('#stat-listen-state').textContent = 'Idle';
            setExpression('idle');
        }

    } catch (err) {
        console.error('[Audio] Send failed:', err);
        logChat('sys', '⚠️ Voice upload failed');
    } finally {
        isTranscribing = false;
        if (!STATE.speaking) $('#stat-listen-state').textContent = 'Idle';
    }
}
