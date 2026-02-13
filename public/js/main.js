// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TUBS BOT — Face UI Controller (Entry Point)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';
import { $ } from './dom.js';
import { logChat, initVerbosityToggle } from './chat-log.js';
import { startIdleLoop, onBlink } from './expressions.js';
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
import { onGazeTargetChanged } from './eye-tracking.js';

let miniWindowRef = null;
let motionRelayInitialized = false;
let headSpeechRelayInitialized = false;
const DUAL_FULLSCREEN_STORAGE_KEY = 'tubs.dualFullscreenDesired';
const MINI_FULLSCREEN_MESSAGE_TYPE = 'tubs-mini-fullscreen';

function postConfigPatch(patch) {
    return fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    }).catch((err) => {
        console.error('[Config] Failed to update runtime config', err);
    });
}

function isMainFullscreenActive() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function writeDualFullscreenIntent(enabled) {
    try {
        localStorage.setItem(DUAL_FULLSCREEN_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
        // ignore storage errors
    }
}

function syncMiniFullscreenIntent(enabled, { openIfNeeded = false } = {}) {
    const desired = Boolean(enabled);
    writeDualFullscreenIntent(desired);

    if (!STATE.dualHeadEnabled || STATE.dualHeadMode === 'off') return;

    let targetWindow = miniWindowRef;
    if ((!targetWindow || targetWindow.closed) && desired && openIfNeeded) {
        targetWindow = ensureMiniWindowOpen();
    }
    if (!targetWindow || targetWindow.closed) return;

    try {
        targetWindow.postMessage({
            type: MINI_FULLSCREEN_MESSAGE_TYPE,
            enabled: desired,
            ts: Date.now(),
        }, location.origin);
    } catch (err) {
        console.warn('[Mini] Failed to post fullscreen intent:', err);
    }
}

function openMiniWindow({ focus = true } = {}) {
    const renderMode = encodeURIComponent(STATE.faceRenderMode || 'svg');
    const url = `/mini.html?faceRenderMode=${renderMode}`;
    const features = 'popup=yes,width=560,height=420,left=80,top=80,resizable=yes';
    const opened = window.open(url, 'tubs-mini-face', features);
    if (!opened) {
        logChat('sys', 'Popup blocked: allow popups to open Mini Window.');
        return null;
    }
    miniWindowRef = opened;
    if (focus) opened.focus();

    // If fullscreen is already active/desired, ask mini to follow once it is ready.
    const fullscreenToggle = document.getElementById('fullscreen-toggle');
    const fullscreenDesired = Boolean(fullscreenToggle?.checked || isMainFullscreenActive());
    if (fullscreenDesired) {
        setTimeout(() => {
            syncMiniFullscreenIntent(true, { openIfNeeded: false });
        }, 400);
    }

    return opened;
}

function ensureMiniWindowOpen() {
    if (!miniWindowRef || miniWindowRef.closed) {
        return openMiniWindow({ focus: true });
    }
    miniWindowRef.focus();
    return miniWindowRef;
}

function initDualHeadMotionRelay() {
    if (motionRelayInitialized) return;
    motionRelayInitialized = true;

    let lastMotionSentAt = 0;
    let lastX = 0;
    let lastY = 0;

    onGazeTargetChanged(({ x, y }) => {
        if (!STATE.dualHeadEnabled || STATE.dualHeadMode === 'off') return;
        const ws = getWs();
        if (!ws || ws.readyState !== 1) return;

        const now = Date.now();
        const dx = Math.abs(x - lastX);
        const dy = Math.abs(y - lastY);
        const minIntervalMs = 33;
        const minDelta = 0.01;
        if (now - lastMotionSentAt < minIntervalMs && dx < minDelta && dy < minDelta) return;

        lastMotionSentAt = now;
        lastX = x;
        lastY = y;
        ws.send(JSON.stringify({
            type: 'face_motion',
            x: Number(x.toFixed(4)),
            y: Number(y.toFixed(4)),
            ts: now,
        }));
    });

    onBlink(() => {
        if (!STATE.dualHeadEnabled || STATE.dualHeadMode === 'off') return;
        const ws = getWs();
        if (!ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'face_blink', ts: Date.now() }));
    });
}

function initHeadSpeechRelay() {
    if (headSpeechRelayInitialized) return;
    headSpeechRelayInitialized = true;

    window.addEventListener('tubs:head-speech-state', (event) => {
        const detail = event?.detail || {};
        const ws = getWs();
        if (!ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({
            type: 'head_speech_state',
            actor: detail.actor === 'small' ? 'small' : 'main',
            state: detail.state === 'end' ? 'end' : 'start',
            turnId: detail.turnId || STATE.currentTurnId || null,
            ts: Number(detail.ts) || Date.now(),
        }));
    });
}

function initVoiceSelector() {
    const select = document.getElementById('tts-voice');
    const secondarySelect = document.getElementById('secondary-tts-voice');
    if (!select) return;

    if (secondarySelect && !secondarySelect.options.length) {
        secondarySelect.innerHTML = select.innerHTML;
    }

    const saved = localStorage.getItem('kokoroVoice');
    if (saved && select.querySelector(`option[value="${saved}"]`)) {
        STATE.kokoroVoice = saved;
    }
    select.value = STATE.kokoroVoice;
    select.addEventListener('change', () => {
        STATE.kokoroVoice = select.value;
        localStorage.setItem('kokoroVoice', select.value);
        postConfigPatch({ kokoroVoice: select.value });
    });
}

function initDualHeadControls() {
    const enabledToggle = document.getElementById('dual-head-enabled');
    const modeSelect = document.getElementById('dual-head-mode');
    const turnPolicySelect = document.getElementById('dual-head-turn-policy');
    const subtitleToggle = document.getElementById('secondary-subtitle-enabled');
    const secondaryVoiceSelect = document.getElementById('secondary-tts-voice');
    const secondaryGain = document.getElementById('secondary-audio-gain');
    const secondaryGainVal = document.getElementById('secondary-audio-gain-val');
    const openMiniWindowBtn = document.getElementById('open-mini-window');

    if (enabledToggle) {
        enabledToggle.addEventListener('change', () => {
            const enabled = enabledToggle.checked;
            STATE.dualHeadEnabled = enabled;
            postConfigPatch({ dualHeadEnabled: enabled });
            if (enabled) {
                ensureMiniWindowOpen();
                const fullscreenToggle = document.getElementById('fullscreen-toggle');
                const fullscreenDesired = Boolean(fullscreenToggle?.checked || isMainFullscreenActive());
                syncMiniFullscreenIntent(fullscreenDesired, { openIfNeeded: false });
            }
        });
    }

    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            const nextMode = modeSelect.value;
            STATE.dualHeadMode = nextMode;
            postConfigPatch({ dualHeadMode: nextMode });
            if (nextMode !== 'off' && enabledToggle?.checked) {
                ensureMiniWindowOpen();
                const fullscreenToggle = document.getElementById('fullscreen-toggle');
                const fullscreenDesired = Boolean(fullscreenToggle?.checked || isMainFullscreenActive());
                syncMiniFullscreenIntent(fullscreenDesired, { openIfNeeded: false });
            }
        });
    }

    if (turnPolicySelect) {
        turnPolicySelect.addEventListener('change', () => {
            postConfigPatch({ dualHeadTurnPolicy: turnPolicySelect.value });
        });
    }

    if (subtitleToggle) {
        subtitleToggle.addEventListener('change', () => {
            postConfigPatch({ secondarySubtitleEnabled: subtitleToggle.checked });
        });
    }

    if (secondaryVoiceSelect) {
        secondaryVoiceSelect.addEventListener('change', () => {
            postConfigPatch({ secondaryVoice: secondaryVoiceSelect.value });
        });
    }

    if (secondaryGain && secondaryGainVal) {
        secondaryGain.addEventListener('input', () => {
            secondaryGainVal.textContent = Number(secondaryGain.value).toFixed(2);
        });
        secondaryGain.addEventListener('change', () => {
            postConfigPatch({ secondaryAudioGain: Number(secondaryGain.value) });
        });
    }

    if (openMiniWindowBtn) {
        openMiniWindowBtn.addEventListener('click', () => {
            openMiniWindow({ focus: true });
        });
    }
}

function initMuteToggle() {
    const muteToggle = document.getElementById('mute-toggle');
    if (!muteToggle) return;
    muteToggle.checked = Boolean(STATE.muted);
    muteToggle.addEventListener('change', () => {
        const muted = Boolean(muteToggle.checked);
        STATE.muted = muted;
        postConfigPatch({ muted });
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
    initMuteToggle();
    initNoiseGate();
    initFullscreenToggle({
        onToggleRequested: (enabled) => {
            syncMiniFullscreenIntent(enabled, { openIfNeeded: Boolean(enabled) });
        },
        onStateChanged: (enabled) => {
            syncMiniFullscreenIntent(enabled, { openIfNeeded: false });
        },
    });
    initVerbosityToggle();
    initVoiceSelector();
    initDualHeadControls();
    initKeyboard();
    initFaceRenderer();
    faceManager.init();
    initEmotionEngine();
    initProactive(getWs);
    initDualHeadMotionRelay();
    initHeadSpeechRelay();

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
