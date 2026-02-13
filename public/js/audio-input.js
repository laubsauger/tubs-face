import { STATE } from './state.js';
import { $, pttIndicator, waveformContainer } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression } from './expressions.js';
import { stopAllTTS } from './tts.js';
import { getWs } from './websocket.js';
import { captureFrameBase64 } from './vision-capture.js';

let myvad = null;
let vadActive = false;
let isTranscribing = false;
let bargeInTimer = null;
let bargeInCount = 0;
let interruptionTimer = null;
let interruptionRecorder = null;
let interruptionChunks = [];
let interrupted = false;
// Chance to interrupt (0.0 - 1.0). 0.2 = 20% chance to set a short timer.
const INTERRUPTION_CHANCE = 0.3;
const SHORT_LIMIT_MS = 5000;  // Interrupt after 5s if active
const LONG_LIMIT_MS = 15000;  // Always interrupt after 15s (safety)

// --- Max chunk duration: force-flush audio if speech runs too long ---
const MAX_SPEECH_DURATION_MS = 15000; // 15 seconds — force-flush if speech never stops
let maxChunkTimer = null;
let chunkRecorder = null;
let chunkRecorderChunks = [];
let speechStartTime = 0;

let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let micStream = null;
let micReady = false;
let visualizeRafId = null;
const ECHO_COOLDOWN_MS = 1500; // ignore mic input briefly after TTS ends

// Barge-in requires noticeably louder speech than the normal noise gate
// to filter out background chatter and distant voices
const BARGE_IN_RMS_FLOOR = 0.03; // absolute minimum RMS for barge-in
const BARGE_IN_GATE_MULTIPLIER = 4; // barge-in threshold = noise gate × this

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
                if (!vadActive || STATE.sleeping) return;
                if (Date.now() - STATE.speakingEndedAt < ECHO_COOLDOWN_MS) return;

                // Barge-in: user starts speaking while Tubs is talking.
                // Requires sustained LOUD speech to confirm — background chatter
                // and distant voices are filtered out by RMS volume check.
                if (STATE.speaking && STATE.currentTurnId) {
                    const rms = getCurrentMicRMS();
                    const threshold = getBargeInThreshold();
                    if (rms < threshold) {
                        console.log(`[VAD] Barge-in ignored — too quiet (RMS ${rms.toFixed(4)} < ${threshold.toFixed(4)})`);
                        return;
                    }
                    bargeInCount++;
                    console.log(`[VAD] Possible barge-in #${bargeInCount} (RMS ${rms.toFixed(4)}) — waiting for sustained speech`);
                    if (bargeInTimer) clearTimeout(bargeInTimer);
                    bargeInTimer = setTimeout(() => {
                        bargeInTimer = null;
                        if (!STATE.speaking) { bargeInCount = 0; return; }
                        if (bargeInCount < 2) { bargeInCount = 0; return; }
                        // Final volume check at confirmation time
                        const confirmRms = getCurrentMicRMS();
                        if (confirmRms < threshold) {
                            console.log(`[VAD] Barge-in cancelled — quiet at confirmation (RMS ${confirmRms.toFixed(4)})`);
                            bargeInCount = 0;
                            return;
                        }
                        console.log(`[VAD] Barge-in confirmed! (RMS ${confirmRms.toFixed(4)}) Stopping TTS.`);
                        bargeInCount = 0;
                        const turnId = STATE.currentTurnId;
                        stopAllTTS();
                        const wsConn = getWs();
                        if (wsConn && wsConn.readyState === 1) {
                            wsConn.send(JSON.stringify({ type: 'interrupt', turnId }));
                        }
                    }, 1500);
                    return;
                }

                console.log('Speech start detected');
                const statState = $('#stat-listen-state');
                if (statState) statState.textContent = 'Listening...';
                setExpression('listening');
                startInterruptionTimer();
                startMaxChunkTimer();
            },
            onSpeechEnd: (audio) => {
                if (interrupted) {
                    console.log('Ignoring VAD speech end (already interrupted)');
                    interrupted = false;
                    clearMaxChunkTimer();
                    return;
                }
                clearInterruptionTimer();
                clearMaxChunkTimer();
                if (!vadActive || STATE.sleeping) return;
                // Don't process audio while Tubs is speaking — it's likely echo
                if (STATE.speaking) {
                    console.log('[VAD] Ignoring speech end — Tubs is speaking (likely echo)');
                    return;
                }
                if (Date.now() - STATE.speakingEndedAt < ECHO_COOLDOWN_MS) {
                    console.log('[VAD] Ignoring speech end — echo cooldown');
                    setExpression('idle');
                    return;
                }
                console.log('Speech end detected');
                processVadAudio(audio);
            },
            onVADMisfire: () => {
                if (bargeInTimer) { clearTimeout(bargeInTimer); bargeInTimer = null; bargeInCount = 0; }
                clearInterruptionTimer();
                clearMaxChunkTimer();
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
        applyVadToggleState(Boolean(e.target.checked), { silent: false });
    });
}

function applyVadToggleState(enabled, { silent = false } = {}) {
    vadActive = Boolean(enabled);
    const toggle = $('#vad-toggle');
    if (toggle) toggle.checked = vadActive;

    if (vadActive) {
        if (!silent) logChat('sys', 'Always On: ENABLED');
        pttIndicator.textContent = 'Listening (Always On)';
        pttIndicator.classList.add('mic-ready');
        waveformContainer.classList.add('active');
        updateWaveformMode();
        startVisualize();
        return;
    }

    if (!silent) logChat('sys', 'Always On: DISABLED');
    pttIndicator.textContent = 'Hold Space to Talk';
    waveformContainer.classList.remove('active');
    $('#stat-listen-state').textContent = 'Idle';
}

export function setAlwaysOnEnabled(enabled, options = {}) {
    applyVadToggleState(Boolean(enabled), options);
}

export function setInputMuted(muted) {
    const nextMuted = Boolean(muted);
    STATE.muted = nextMuted;

    if (!nextMuted) return;

    setAlwaysOnEnabled(false, { silent: true });
    clearInterruptionTimer();
    clearMaxChunkTimer();
    interrupted = false;
    isTranscribing = false;

    if (STATE.recording) {
        stopRecording();
    }

    $('#stat-listen-state').textContent = 'Idle';
    updateWaveformMode();
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

/** Live mic RMS from analyser node — used for barge-in volume checks */
function getCurrentMicRMS() {
    if (!analyser) return 0;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return computeRMS(data);
}

function getBargeInThreshold() {
    return Math.max(BARGE_IN_RMS_FLOOR, (STATE.vadNoiseGate || 0.008) * BARGE_IN_GATE_MULTIPLIER);
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

    console.log(`[VAD] RMS ${rms.toFixed(4)} — sending segment`);
    const wavBlob = audioBufferToWav(float32Array);
    sendVoiceSegment(wavBlob);
}

async function sendVoiceSegment(blob) {
    if (STATE.muted) return;
    if (!STATE.connected) {
        logChat('sys', 'Not connected — voice not sent');
        return;
    }

    // Capture camera frame and send to server before voice segment
    const frame = captureFrameBase64();
    if (frame) {
        const wsConn = getWs();
        if (wsConn && wsConn.readyState === 1) {
            wsConn.send(JSON.stringify({ type: 'camera_frame', frame }));
        }
    }

    // Non-blocking: don't set isTranscribing, allow more segments
    const statState = $('#stat-listen-state');
    if (statState) statState.textContent = 'Accumulating...';

    try {
        const res = await fetch('/voice/segment?wakeWord=true', {
            method: 'POST',
            body: blob,
            headers: { 'Content-Type': 'audio/webm' }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.ignored) {
            console.log(`[Segment] Ignored: "${data.text}"`);
            if (statState) statState.textContent = 'Idle';
            if (!data.text || !data.wake) setExpression('idle');
        }
    } catch (err) {
        console.error('[Audio] Segment send failed:', err);
    }
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

        // Restart max chunk timer so it records fresh from this point
        startMaxChunkTimer();

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

// --- Max chunk duration: force-flush long continuous speech ---
function startMaxChunkTimer() {
    clearMaxChunkTimer();
    speechStartTime = Date.now();

    // Start a parallel recorder to capture audio for the forced flush
    if (micStream) {
        try {
            chunkRecorderChunks = [];
            chunkRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' });
            chunkRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunkRecorderChunks.push(e.data);
            };
            chunkRecorder.start();
        } catch (e) {
            console.error('[VAD] Failed to start chunk recorder:', e);
        }
    }

    maxChunkTimer = setTimeout(() => {
        if (!vadActive || STATE.speaking || STATE.sleeping) {
            clearMaxChunkTimer();
            return;
        }

        const elapsed = Date.now() - speechStartTime;
        console.log(`[VAD] Max chunk duration reached (${Math.round(elapsed / 1000)}s) — force-flushing audio`);

        // Stop the chunk recorder and send its audio
        if (chunkRecorder && chunkRecorder.state === 'recording') {
            const recorder = chunkRecorder;
            recorder.onstop = () => {
                if (chunkRecorderChunks.length > 0) {
                    const blob = new Blob(chunkRecorderChunks, { type: 'audio/webm' });
                    console.log(`[VAD] Force-flushed ${Math.round(blob.size / 1024)}KB of audio`);
                    sendVoice(blob, true);
                }
                chunkRecorderChunks = [];
            };
            recorder.stop();
        }
        chunkRecorder = null;

        // Also clear the interruption timer since we're handling the flush
        clearInterruptionTimer();
        interrupted = true; // Tell onSpeechEnd to ignore the next event from this segment

        // Restart the timer for the *next* chunk of continuous speech
        startMaxChunkTimer();

    }, MAX_SPEECH_DURATION_MS);
}

function clearMaxChunkTimer() {
    if (maxChunkTimer) {
        clearTimeout(maxChunkTimer);
        maxChunkTimer = null;
    }
    if (chunkRecorder) {
        if (chunkRecorder.state === 'recording') {
            chunkRecorder.stop();
        }
        chunkRecorder = null;
    }
    chunkRecorderChunks = [];
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
    if (STATE.recording || STATE.sleeping || !micReady || STATE.muted) return;

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
    if (STATE.muted) return;
    if (!STATE.connected) {
        logChat('sys', 'Not connected — voice not sent');
        return;
    }

    // Capture camera frame and send to server before voice transcription
    const frame = captureFrameBase64();
    if (frame) {
        const wsConn = getWs();
        if (wsConn && wsConn.readyState === 1) {
            wsConn.send(JSON.stringify({ type: 'camera_frame', frame }));
        }
    }

    isTranscribing = true;
    updateWaveformMode();
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
        updateWaveformMode();
        if (!STATE.speaking) $('#stat-listen-state').textContent = 'Idle';
    }
}

/**
 * Update the waveform container CSS class to reflect current mic state:
 * - 'waveform-idle': gray — waiting for wake/trigger phrase
 * - 'waveform-convo': green — in active conversation mode
 * - 'waveform-transcribing': blue — currently transcribing audio
 */
export function updateWaveformMode() {
    const el = waveformContainer;
    if (!el) return;
    el.classList.remove('waveform-idle', 'waveform-convo', 'waveform-transcribing');

    if (isTranscribing) {
        el.classList.add('waveform-transcribing');
    } else if (STATE.inConversation) {
        el.classList.add('waveform-convo');
    } else {
        el.classList.add('waveform-idle');
    }
}
