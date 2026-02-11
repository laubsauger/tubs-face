// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face UI Controller (Entry Point)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';
import { $ } from './dom.js';
import { logChat, initVerbosityToggle } from './chat-log.js';
import { startIdleLoop } from './expressions.js';
import { connectWS, getWs } from './websocket.js';
import { initMicrophone, initVAD, initVadToggle, initNoiseGate, initWaveformBars } from './audio-input.js';
import { resetSleepTimer, enterSleep, initSleepSlider } from './sleep.js';
import { initKeyboard } from './keyboard.js';
import { initPanelCollapse, initPanelResize, startUptimeTimer } from './panel-ui.js';
import { faceManager } from './face/index.js';
import { initEmotionEngine } from './emotion-engine.js';
import { initFullscreenToggle } from './fullscreen.js';
import { checkAndRunIngestion } from './face/ingest.js';
import { initFaceRenderer } from './face-renderer.js';
import { initProactive } from './proactive.js';

function initVoiceSelector() {
    const select = document.getElementById('tts-voice');
    if (!select) return;
    const saved = localStorage.getItem('kokoroVoice');
    if (saved && select.querySelector(`option[value="${saved}"]`)) {
        STATE.kokoroVoice = saved;
    }
    select.value = STATE.kokoroVoice;
    select.addEventListener('change', () => {
        STATE.kokoroVoice = select.value;
        localStorage.setItem('kokoroVoice', select.value);
        fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kokoroVoice: select.value }),
        });
    });
}

function init() {
    STATE.wakeTime = Date.now();
    $('#stat-awake').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    $('#stat-model').textContent = STATE.model;
    logChat('sys', 'Tubs Bot initializing...');

    console.log('[Init] Initializing...');

    initWaveformBars();
    initPanelCollapse();
    initPanelResize();
    initSleepSlider();
    initVadToggle();
    initNoiseGate();
    initFullscreenToggle();
    initVerbosityToggle();
    initVoiceSelector();
    initKeyboard();
    initFaceRenderer();
    faceManager.init();
    initEmotionEngine();
    initProactive(getWs);

    connectWS();
    resetSleepTimer();
    initMicrophone();
    initVAD();

    startIdleLoop();
    startUptimeTimer();

    // Start asleep — camera will wake us when a face is detected
    enterSleep();

    // Auto-start camera for presence detection while sleeping
    setTimeout(() => {
        const camToggle = document.getElementById('camera-toggle');
        if (camToggle && !camToggle.checked) {
            camToggle.checked = true;
            camToggle.dispatchEvent(new Event('change'));
        }

        // Auto-start "Always On" microphone
        const vadToggle = document.getElementById('vad-toggle');
        if (vadToggle && !vadToggle.checked) {
            vadToggle.checked = true;
            vadToggle.dispatchEvent(new Event('change'));
        }

        // Check for new faces to ingest
        checkAndRunIngestion();
        setInterval(checkAndRunIngestion, 30000); // Check every 30s
    }, 500);
}

init();
