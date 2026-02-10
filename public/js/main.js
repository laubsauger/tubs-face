// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face UI Controller
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const STATE = {
    connected: false,
    sleeping: false,
    speaking: false,
    recording: false,
    expression: 'idle',
    turns: 0,
    totalMessages: 0,
    tokensIn: 0,
    tokensOut: 0,
    totalCost: 0,
    ttsQueue: [],
    wakeTime: Date.now(),
    sleepTimeout: 10000,
    lastActivity: Date.now(),
    model: 'Tubs Bot v1',
    // Face detection
    cameraActive: false,
    faceWorkerReady: false,
    facesDetected: 0,
    personsPresent: [],
    presenceDetected: false,
};

// ── DOM References ──
const $ = (sel) => document.querySelector(sel);
const body = document.body;
const face = $('#face');
const mouth = $('#mouth');
const eyes = document.querySelectorAll('.eye');
const loadingBar = $('#loading-bar');
const speechBubble = $('#speech-bubble');
const pttIndicator = $('#ptt-indicator');
const waveformContainer = $('#waveform-container');
const chatLog = $('#chat-log');

// ── WebSocket ──
let ws = null;
// Expose ws globally for face-manager
Object.defineProperty(window, 'ws', { get() { return ws; } });
let pingInterval = null;
let lastPingTs = null;

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
        STATE.connected = true;
        updateConnectionUI(true);
        logChat('sys', 'Connected to bridge server');
        startPing();
    };

    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            handleMessage(msg);
        } catch (err) {
            console.error('Bad WS message:', err);
        }
    };

    ws.onclose = () => {
        STATE.connected = false;
        updateConnectionUI(false);
        logChat('sys', 'Disconnected — reconnecting...');
        stopPing();
        setTimeout(connectWS, 3000);
    };

    ws.onerror = () => {
        ws.close();
    };
}

function startPing() {
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === 1) {
            lastPingTs = Date.now();
            ws.send(JSON.stringify({ type: 'ping', ts: lastPingTs }));
        }
    }, 5000);
}

function stopPing() {
    clearInterval(pingInterval);
}

// ── Message Handler ──
function handleMessage(msg) {
    // Only count real interactions as activity (not pings/stats/config)
    if (msg.type !== 'ping' && msg.type !== 'stats' && msg.type !== 'config') {
        STATE.lastActivity = Date.now();
    }

    switch (msg.type) {
        case 'speak':
            enqueueSpeech(msg.text);
            logChat('in', msg.text);
            STATE.totalMessages++;
            break;
        case 'incoming':
            logChat('out', msg.text);
            setExpression('listening');
            break;
        case 'thinking':
            setExpression('thinking');
            loadingBar.classList.add('active');
            break;
        case 'expression':
            setExpression(msg.expression);
            break;
        case 'system':
            logChat('sys', msg.text);
            break;
        case 'error':
            logChat('sys', `ERROR: ${msg.text}`);
            loadingBar.classList.remove('active');
            setExpression('idle');
            break;
        case 'sleep':
            enterSleep();
            break;
        case 'wake':
            exitSleep();
            break;
        case 'stats':
            if (msg.latency) $('#stat-resp-time').textContent = `${msg.latency} ms`;
            if (msg.tokens) {
                STATE.tokensIn += msg.tokens.in || 0;
                STATE.tokensOut += msg.tokens.out || 0;
                $('#stat-tok-in').textContent = STATE.tokensIn;
                $('#stat-tok-out').textContent = STATE.tokensOut;
            }
            if (msg.model) {
                STATE.model = msg.model;
                $('#stat-model').textContent = msg.model;
            }
            if (msg.cost != null) {
                STATE.totalCost += msg.cost;
                $('#stat-cost').textContent = `$${STATE.totalCost.toFixed(4)}`;
            }
            break;
        case 'config':
            if (msg.sleepTimeout) STATE.sleepTimeout = msg.sleepTimeout;
            if (msg.model) {
                STATE.model = msg.model;
                $('#stat-model').textContent = msg.model;
            }
            break;
        // case 'ping' removed
        // case 'ping':
        //     if (lastPingTs) {
        //         const latency = Date.now() - lastPingTs;
        //         // $('#stat-latency').textContent = `${latency} ms`;
        //     }
        //     break;
    }
}

// ── Connection UI ──
function updateConnectionUI(isConnected) {
    const dot = $('#conn-dot');
    const headerDot = $('#header-conn-dot');
    const val = $('#stat-conn');

    if (isConnected) {
        dot.className = 'dot green';
        if (headerDot) headerDot.className = 'dot green header-dot';
        val.innerHTML = '<span class="dot green" id="conn-dot"></span>Online';
        val.classList.remove('offline');
        val.classList.add('online');
    } else {
        dot.className = 'dot red';
        if (headerDot) headerDot.className = 'dot red header-dot';
        val.innerHTML = '<span class="dot red" id="conn-dot"></span>Offline';
        val.classList.remove('online');
        val.classList.add('offline');
    }
}

// ── Chat Log ──
function logChat(type, text) {
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const prefix = type === 'in' ? '◂' : type === 'out' ? '▸' : '◆';
    msg.innerHTML = `<span class="ts">${ts}</span><span class="content">${prefix} ${escapeHTML(text)}</span>`;
    chatLog.appendChild(msg);
    chatLog.scrollTop = chatLog.scrollHeight;

    // Trim old messages
    while (chatLog.children.length > 100) {
        chatLog.removeChild(chatLog.firstChild);
    }

    // Update counters
    if (type === 'in' || type === 'out') {
        STATE.turns = Math.floor(STATE.totalMessages / 2);
        $('#turn-counter').textContent = `${STATE.turns} turns`;
    }
    $('#stat-last-heard').textContent = ts;
}

function escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ── Expressions ──
function setExpression(expr) {
    STATE.expression = expr;
    $('#stat-expression').textContent = expr.toUpperCase();

    // Reset
    mouth.className = '';
    loadingBar.classList.remove('active');

    switch (expr) {
        case 'idle':
            break;
        case 'listening':
            mouth.className = '';
            break;
        case 'speaking':
            mouth.className = 'speaking';
            break;
        case 'thinking':
            mouth.className = 'thinking';
            loadingBar.classList.add('active');
            break;
        case 'smile':
            mouth.className = 'smile';
            break;
        case 'happy':
            mouth.className = 'smile';
            break;
    }
}

// ── TTS Queue ──
function enqueueSpeech(text) {
    STATE.ttsQueue.push(text);
    $('#stat-queue').textContent = STATE.ttsQueue.length;
    if (!STATE.speaking) processQueue();
}

function processQueue() {
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

    // Show speech bubble
    speechBubble.textContent = text;
    speechBubble.classList.add('visible');
    loadingBar.classList.remove('active');

    playTTS(text).catch(() => {
        STATE.speaking = false;
        processQueue();
    });
}

// ── Sleep Mode ──
let sleepTimer = null;

function resetSleepTimer() {
    clearInterval(sleepTimer);
    sleepTimer = null;
    if (STATE.sleepTimeout > 0 && !STATE.sleeping) {
        sleepTimer = setInterval(() => {
            if (Date.now() - STATE.lastActivity > STATE.sleepTimeout) {
                enterSleep();
            }
        }, 2000);
    }
}

function enterSleep() {
    if (STATE.sleeping) return;
    // Don't sleep while faces are visible
    if (STATE.facesDetected > 0) return;
    STATE.sleeping = true;
    body.classList.add('sleeping');
    clearInterval(sleepTimer);
    sleepTimer = null;
    speechSynthesis?.cancel();
    STATE.ttsQueue = [];
    STATE.speaking = false;
    STATE.presenceDetected = false;
    setExpression('idle');
    if (window.resetGaze) window.resetGaze();
    logChat('sys', '💤 Sleep mode');
}

function exitSleep() {
    if (!STATE.sleeping) return;
    STATE.sleeping = false;
    body.classList.remove('sleeping');
    STATE.wakeTime = Date.now();
    STATE.lastActivity = Date.now();
    $('#stat-awake').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

    // Staggered panel fade-in
    document.querySelectorAll('.panel').forEach((p, i) => {
        p.style.opacity = '0';
        setTimeout(() => { p.style.opacity = ''; }, 100 + i * 200);
    });

    logChat('sys', '☀️ Awake!');
    resetSleepTimer();

    // Blink on wake
    triggerBlink();
}

// ── Blinking ──
function triggerBlink() {
    eyes.forEach(e => e.classList.add('blink'));
    setTimeout(() => eyes.forEach(e => e.classList.remove('blink')), 200);
}

// Random blinking
setInterval(() => {
    if (!STATE.sleeping && Math.random() < 0.3) {
        triggerBlink();
    }
}, 3000);

// ── Voice & VAD ──
let myvad = null;
let vadActive = false;
let isTranscribing = false;

async function initVAD() {
    try {
        logChat('sys', 'Initializing VAD...');

        // Suppress ONNX warnings
        if (window.ort) {
            ort.env.logLevel = 'error';
        }

        // Note: vad is exposed globally by the script tag as `vad`
        myvad = await vad.MicVAD.new({
            onSpeechStart: () => {
                if (!vadActive || isTranscribing || STATE.speaking || STATE.sleeping) return;
                console.log('Speech start detected');
                $('#stat-listen-state').textContent = 'Listening...';
                setExpression('listening');
            },
            onSpeechEnd: (audio) => {
                if (!vadActive || isTranscribing || STATE.speaking || STATE.sleeping) return;
                console.log('Speech end detected');
                processVadAudio(audio);
            },
            onVADMisfire: () => {
                console.log('VAD Misfire');
                $('#stat-listen-state').textContent = 'Idle';
                setExpression('idle');
            }
        });

        // Start VAD logic but keep it paused until toggle
        // actually myvad.start() starts listening. 
        // We'll control via 'vadActive' flag or start/pause methods if available.
        // The library usually starts immediately upon creation if not careful.
        myvad.start();

        logChat('sys', 'VAD Ready');

    } catch (e) {
        console.error("VAD Init failed:", e);
        logChat('sys', '⚠️ VAD Init Failed');
    }
}

// Toggle VAD
$('#vad-toggle').addEventListener('change', (e) => {
    vadActive = e.target.checked;
    if (vadActive) {
        logChat('sys', 'Always On: ENABLED');
        pttIndicator.textContent = 'Listening (Always On)';
        pttIndicator.classList.add('mic-ready');
        waveformContainer.classList.add('active'); // Show bars
        visualizeAudio(); // Start loop
    } else {
        logChat('sys', 'Always On: DISABLED');
        pttIndicator.textContent = 'Hold Space to Talk';
        waveformContainer.classList.remove('active'); // Hide bars
        $('#stat-listen-state').textContent = 'Idle';
    }
});

async function processVadAudio(float32Array) {
    // Convert Float32Array to Wav Blob
    const wavBlob = audioBufferToWav(float32Array);
    sendVoice(wavBlob, true);
}

// Utility to convert VAD Float32 to WAV
function audioBufferToWav(float32Array) {
    const buffer = new ArrayBuffer(44 + float32Array.length * 2);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + float32Array.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, 16000, true); // Sample rate (VAD default)
    view.setUint32(28, 32000, true); // Byte rate
    view.setUint16(32, 2, true); // Block align
    view.setUint16(34, 16, true); // Bits per sample
    writeString(view, 36, 'data');
    view.setUint32(40, float32Array.length * 2, true);

    // PCM samples
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

// ── Manual Recording (Fallback / PTT) ──
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let micStream = null;
let micReady = false;

// Create waveform bars
for (let i = 0; i < 20; i++) {
    const bar = document.createElement('div');
    bar.className = 'wave-bar';
    waveformContainer.appendChild(bar);
}

async function initMicrophone() {
    // Check if getUserMedia is even available (requires localhost or HTTPS)
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
        $('#stat-mic').textContent = 'Ready';
        $('#stat-mic').style.color = 'var(--accent)';
        pttIndicator.textContent = 'Hold Space to Talk';
        pttIndicator.classList.add('mic-ready');
    } catch (err) {
        logChat('sys', `⚠️ Mic denied: ${err.message}`);
        $('#stat-mic').textContent = 'Denied';
        $('#stat-mic').style.color = 'var(--error)';
        pttIndicator.textContent = '⚠ Mic Access Denied';
        pttIndicator.classList.add('mic-denied');
    }
}

function startRecording() {
    console.log('[Audio] startRecording triggered', {
        recording: STATE.recording,
        sleeping: STATE.sleeping,
        micReady: micReady
    });
    if (STATE.recording || STATE.sleeping || !micReady) return;

    // Resume AudioContext if it was suspended (browser autoplay policy)
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
    visualizeAudio();
}

function stopRecording() {
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
    if ((!STATE.recording && !vadActive) || !analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    const bars = waveformContainer.children;
    for (let i = 0; i < bars.length; i++) {
        const val = data[i] || 0;
        bars[i].style.height = `${Math.max(4, (val / 255) * 30)}px`;
    }

    // Volume meter
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const volPct = Math.min(100, (avg / 128) * 100);
    $('#stat-vol').style.width = `${volPct}%`;

    requestAnimationFrame(visualizeAudio);
}

// ... refactor PTT to use similar pipeline or keep MediaRecorder ...
// Reusing MediaRecorder for PTT as it captures from same mic stream
// IMPORTANT: VAD library might hog the mic stream. 
// Ideally we share the stream. @ricky0123/vad-web handles getUserMedia internally.
// Function initMicrophone needs to be adjusted to NOT get user media if VAD does it, 
// OR we pass the stream to VAD.
// For now, let's keep PTT using MediaRecorder and VAD separate, potentially requesting mic twice?
// Creating two streams is fine usually.

async function sendVoice(blob, isVad = false) {
    if (!STATE.connected) {
        logChat('sys', 'Not connected — voice not sent');
        return;
    }

    isTranscribing = true;
    $('#stat-listen-state').textContent = 'Transcribing...';
    logChat('sys', 'Transcribing audio...');

    // Play "Uhum" immediately to acknowledge (local fake or short sound)
    // playUhum(); // Optional implementation

    try {
        const url = isVad ? '/voice?wakeWord=true' : '/voice';

        const res = await fetch(url, {
            method: 'POST',
            body: blob,
            headers: {
                'Content-Type': 'audio/webm' // or wav
            }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        if (data.text) {
            // Log everything for debug
            const wakeInfo = data.wake
                ? ` [wake:${data.wake.version || 'unknown'} ${data.wake.reason || 'n/a'} ${data.wake.matchedToken || ''}]`
                : '';
            const prefix = data.ignored ? `[Ignored${wakeInfo}] ` : '';
            logChat('sys', `${prefix}"${data.text}"`);
        }

        if (data.ignored) {
            $('#stat-listen-state').textContent = 'Idle';
            setExpression('idle');
        } else {
            // Success, text processed in background via WS
            // Bridge already broadcasts processing state
            // logChat('sys', 'Audio processed.'); // Duplicate
        }

    } catch (err) {
        console.error('[Audio] Send failed:', err);
        logChat('sys', '⚠️ Voice upload failed');
        // Fallback demo
    } finally {
        isTranscribing = false;
        if (!STATE.speaking) $('#stat-listen-state').textContent = 'Idle';
    }
}

// ── TTS Output ──
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

        // Debug blob size
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
            processQueue(); // Call next
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

// Update processQueue to use `playTTS` instead of `speechSynthesis`
// ... needs modifying processQueue ...
// Let's modify processQueue in a separate chunk to replace `speechSynthesis` usage.


// ── Keyboard Input ──
let keyInputBuffer = '';

// Single-char shortcut keys (must not enter the text buffer)
const SHORTCUT_KEYS = new Set(['z', 'Z', 's', 'S', 'c', 'C', 'f', 'F', 'd', 'D']);

document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input element
    const inInput = document.activeElement && document.activeElement.tagName === 'INPUT';

    // Spacebar push-to-talk
    if (e.code === 'Space' && !e.repeat && document.activeElement === document.body) {
        e.preventDefault();
        if (STATE.sleeping) {
            exitSleep();
            return;
        }
        startRecording();
        return;
    }

    // Escape = sleep
    if (e.code === 'Escape') {
        if (STATE.sleeping) exitSleep();
        else enterSleep();
        return;
    }

    // Enter = send typed text
    if (e.code === 'Enter' && keyInputBuffer.trim()) {
        e.preventDefault();
        const text = keyInputBuffer.trim();
        keyInputBuffer = '';

        if (STATE.sleeping) exitSleep();

        // Check for sleep command
        if (/go to sleep/i.test(text)) {
            enterSleep();
            return;
        }

        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'incoming', text }));
            logChat('out', text);
            STATE.totalMessages++;
            $('#stat-input-src').textContent = 'Keyboard';
            STATE.lastActivity = Date.now();
        }
        return;
    }

    // Single-key shortcuts (only when not in an input field)
    if (!inInput && SHORTCUT_KEYS.has(e.key)) {
        if (e.key === 'z' || e.key === 'Z') {
            document.getElementById('grid').classList.toggle('hidden-ui');
        }
        if (e.key === 's' || e.key === 'S') {
            if (STATE.sleeping) exitSleep();
            else enterSleep();
        }
        if (e.key === 'c' || e.key === 'C') {
            const toggle = document.getElementById('camera-toggle');
            if (toggle) {
                toggle.checked = !toggle.checked;
                toggle.dispatchEvent(new Event('change'));
            }
        }
        if (e.key === 'f' || e.key === 'F') {
            if (window.faceManager) window.faceManager.enrollFace();
        }
        if (e.key === 'd' || e.key === 'D') {
            if (window.faceManager) window.faceManager.toggleDebug();
        }
        return; // Don't buffer shortcut keys
    }

    // Buffer printable keys
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        keyInputBuffer += e.key;
    }
    if (e.code === 'Backspace') {
        keyInputBuffer = keyInputBuffer.slice(0, -1);
    }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && STATE.recording) {
        stopRecording();
    }
});

// Wake on click
document.addEventListener('click', () => {
    if (STATE.sleeping) exitSleep();
});

// ── Sleep Timeout Slider ──
const sleepSlider = document.getElementById('sleep-timeout');
const sleepSliderVal = document.getElementById('sleep-timeout-val');

sleepSlider.addEventListener('input', () => {
    const secs = parseInt(sleepSlider.value, 10);
    STATE.sleepTimeout = secs * 1000;
    if (secs >= 60) {
        sleepSliderVal.textContent = `${Math.round(secs / 60)}m`;
    } else {
        sleepSliderVal.textContent = `${secs}s`;
    }
    resetSleepTimer();
});

// ── Timers ──

// Uptime
setInterval(() => {
    if (STATE.sleeping) return;
    const elapsed = Math.floor((Date.now() - STATE.wakeTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    $('#stat-uptime').textContent = `${h}:${m}:${s}`;
}, 1000);

// Clock removed

// ── Interaction: Collapsible Panels ──
// Ensure this runs after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.panel-title').forEach(title => {
        title.addEventListener('click', () => {
            console.log('Panel clicked'); // Debug
            const panel = title.parentElement;
            panel.classList.toggle('collapsed');
        });
    });
});

// Keyboard shortcuts are consolidated in the single keydown handler above.

// ── Init ──
function init() {
    STATE.wakeTime = Date.now();
    $('#stat-awake').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    $('#stat-model').textContent = STATE.model;
    logChat('sys', 'Tubs Bot initializing...');

    console.log('[Init] Initializing...');

    connectWS();
    resetSleepTimer();
    initMicrophone();
    initVAD();

    // ── Idle Loop (Alive) ──
    startIdleLoop();

    // Start asleep — camera will wake us when a face is detected
    enterSleep();

    // Auto-start camera for presence detection while sleeping
    setTimeout(() => {
        const camToggle = document.getElementById('camera-toggle');
        if (camToggle && !camToggle.checked) {
            camToggle.checked = true;
            camToggle.dispatchEvent(new Event('change'));
        }
    }, 500);
}

// ── Alive Animations ──
function startIdleLoop() {
    // Blink loop
    setInterval(() => {
        if (STATE.sleeping) return;
        blink();
    }, 4000 + Math.random() * 2000);

    // Smile loop
    setInterval(() => {
        if (STATE.sleeping || STATE.speaking || STATE.expression !== 'idle') return;

        const r = Math.random();
        if (r < 0.2) {
            setExpression('smile');
            setTimeout(() => {
                if (STATE.expression === 'smile') setExpression('idle');
            }, 2000);
        }
    }, 5000);
}

function blink() {
    eyes.forEach(eye => eye.classList.add('blink'));
    setTimeout(() => {
        eyes.forEach(eye => eye.classList.remove('blink'));
    }, 150);
}


// ── Chat Log Panel Resize ──
(function () {
    const panel = document.getElementById('panel-bl');
    const handle = document.getElementById('panel-bl-resize');
    if (!panel || !handle) return;

    let startX, startW;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        panel.classList.add('resizing');
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onUp);
    });

    function onDrag(e) {
        const delta = e.clientX - startX;
        const newW = Math.max(200, Math.min(800, startW + delta));
        panel.style.width = newW + 'px';
        panel.style.maxWidth = newW + 'px';
    }

    function onUp() {
        panel.classList.remove('resizing');
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', onUp);
    }
})();

// ── Eye Tracking ──
const pupils = document.querySelectorAll('.pupil');

// lookAt(x, y) — x,y in [-1, 1] range (0,0 = center)
function lookAt(x, y) {
    // Max pixel offset proportional to eye size (~30% of eye width)
    const maxX = 6;
    const maxY = 4;
    const px = Math.max(-maxX, Math.min(maxX, x * maxX));
    const py = Math.max(-maxY, Math.min(maxY, y * maxY));
    pupils.forEach(p => {
        p.style.setProperty('--look-x', `${px}px`);
        p.style.setProperty('--look-y', `${py}px`);
    });
}

function resetGaze() {
    pupils.forEach(p => {
        p.style.setProperty('--look-x', '0px');
        p.style.setProperty('--look-y', '0px');
    });
}

// ── Expose for face-manager.js ──
window.STATE = STATE;
window.exitSleep = exitSleep;
window.logChat = logChat;
window.lookAt = lookAt;
window.resetGaze = resetGaze;
window.enqueueSpeech = enqueueSpeech;

init();
