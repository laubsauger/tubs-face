// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face UI Controller (Entry Point)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';
import { $ } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression, triggerBlink, startIdleLoop } from './expressions.js';
import { connectWS } from './websocket.js';
import { initMicrophone, initVAD, initVadToggle, initWaveformBars } from './audio-input.js';
import { resetSleepTimer, enterSleep, initSleepSlider } from './sleep.js';
import { initKeyboard } from './keyboard.js';
import { initPanelCollapse, initPanelResize, startUptimeTimer } from './panel-ui.js';
import { faceManager } from './face/index.js';

// Random blinking
setInterval(() => {
    if (!STATE.sleeping && Math.random() < 0.3) {
        triggerBlink();
    }
}, 3000);

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
    initKeyboard();
    faceManager.init();

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
    }, 500);
}

init();
