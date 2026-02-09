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
    sleepTimeout: 300000,
    lastActivity: Date.now(),
    model: 'Tubs Bot v1',
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
    STATE.lastActivity = Date.now();

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
        case 'ping':
            if (lastPingTs) {
                const latency = Date.now() - lastPingTs;
                $('#stat-latency').textContent = `${latency} ms`;
            }
            break;
    }
}

// ── Connection UI ──
function updateConnectionUI(connected) {
    const el = $('#stat-conn');
    const dot = $('#conn-dot');
    if (connected) {
        el.innerHTML = '<span class="dot green"></span>Online';
        el.className = 'stat-value online';
    } else {
        el.innerHTML = '<span class="dot red"></span>Offline';
        el.className = 'stat-value offline';
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
        setExpression('smile');
        speechBubble.classList.remove('visible');
        $('#stat-listen-state').textContent = 'Idle';
        setTimeout(() => setExpression('idle'), 2000);
        return;
    }

    STATE.speaking = true;
    const text = STATE.ttsQueue.shift();
    $('#stat-queue').textContent = STATE.ttsQueue.length;

    // Show speech bubble
    speechBubble.textContent = text;
    speechBubble.classList.add('visible');

    // Animate mouth
    setExpression('speaking');
    loadingBar.classList.remove('active');

    // Use Python TTS
    playTTS(text);
}

// ── Sleep Mode ──
let sleepTimer = null;

function resetSleepTimer() {
    clearTimeout(sleepTimer);
    if (STATE.sleepTimeout > 0 && !STATE.sleeping) {
        sleepTimer = setInterval(() => {
            if (Date.now() - STATE.lastActivity > STATE.sleepTimeout) {
                enterSleep();
            }
        }, 10000);
    }
}

function enterSleep() {
    if (STATE.sleeping) return;
    STATE.sleeping = true;
    body.classList.add('sleeping');
    speechSynthesis?.cancel();
    STATE.ttsQueue = [];
    STATE.speaking = false;
    setExpression('idle');
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
        pttIndicator.classList.add('mic-ready'); // reuse style
    } else {
        logChat('sys', 'Always On: DISABLED');
        pttIndicator.textContent = 'Hold Space to Talk';
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
    if (!STATE.recording || !analyser) return;
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

        if (data.ignored) {
            logChat('sys', '(Ignored - No Wake Word)');
            $('#stat-listen-state').textContent = 'Idle';
            setExpression('idle');
        } else {
            // Success, text processed in background via WS
            // Bridge already broadcasts processing state
            logChat('sys', 'Audio processed.');
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
        const audioURL = URL.createObjectURL(blob);
        const audio = new Audio(audioURL);

        audio.onended = () => {
            processQueue(); // Call next
            URL.revokeObjectURL(audioURL);
        };

        audio.play();

    } catch (e) {
        console.error("TTS Error:", e);
        // Fallback?
        processQueue();
    }
}

// Update processQueue to use `playTTS` instead of `speechSynthesis`
// ... needs modifying processQueue ...
// Let's modify processQueue in a separate chunk to replace `speechSynthesis` usage.


// ── Keyboard Input ──
let keyInputBuffer = '';

document.addEventListener('keydown', (e) => {
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

// Clock
setInterval(() => {
    $('#stat-clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}, 10000);
$('#stat-clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

// ── Responsive Face ──
function resizeFace() {
    const center = $('#center');
    const face = $('#face');
    if (!center || !face) return;

    const navHeight = 0; // Adjust if header/footer exists
    const availableWidth = center.clientWidth;
    const availableHeight = center.clientHeight - navHeight;

    const baseWidth = 350;
    const baseHeight = 220;
    const padding = 40;

    const scaleX = (availableWidth - 20) / baseWidth; // Reduced padding
    const scaleY = (availableHeight - 20) / baseHeight;

    // Fit to whichever dimension is more constrained, but allow it to go as big as needed
    const scale = Math.min(scaleX, scaleY);

    // Apply scale while preserving centering (translate)
    face.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

window.addEventListener('resize', resizeFace);

// ── Init ──
function init() {
    STATE.wakeTime = Date.now();
    $('#stat-awake').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    $('#stat-model').textContent = STATE.model;
    logChat('sys', 'Tubs Bot initializing...');

    // Debug
    console.log('[Init] Initializing...');

    connectWS();
    resetSleepTimer();
    initMicrophone();

    // Initial resize
    setTimeout(resizeFace, 100);
}

init();
