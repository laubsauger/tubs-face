import { STATE } from './state.js';
import { $, body, subtitleEl } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression, triggerBlink } from './expressions.js';
import { resetGaze } from './eye-tracking.js';
import { hideDonationQr } from './donation-ui.js';
import { stopAllTTS } from './tts.js';

let sleepTimer = null;

function syncSleepState(isSleeping) {
    const endpoint = isSleeping ? '/sleep' : '/wake';
    fetch(endpoint, { method: 'POST' }).catch((err) => {
        console.warn(`[Sleep] Failed to sync ${endpoint}:`, err);
    });
}

export function resetSleepTimer() {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    if (STATE.sleepTimeout > 0 && !STATE.sleeping) {
        const elapsed = Date.now() - STATE.lastActivity;
        const remaining = Math.max(500, STATE.sleepTimeout - elapsed);
        sleepTimer = setTimeout(() => {
            sleepTimer = null;
            if (Date.now() - STATE.lastActivity >= STATE.sleepTimeout) {
                enterSleep();
                // If enterSleep was blocked (speaking, conversation, etc.), retry later
                if (!STATE.sleeping) {
                    resetSleepTimer();
                }
            } else {
                resetSleepTimer();
            }
        }, remaining);
    }
}

export function enterSleep(options = {}) {
    const shouldSync = options.sync !== false;
    if (STATE.sleeping) {
        console.log('[Sleep] enterSleep blocked: already sleeping');
        return;
    }
    if (STATE.facesDetected > 0) {
        console.log('[Sleep] enterSleep blocked: facesDetected=' + STATE.facesDetected);
        return;
    }
    if (STATE.speaking || STATE.ttsQueue?.length > 0) {
        console.log('[Sleep] enterSleep blocked: still speaking');
        return;
    }
    if (STATE.inConversation) {
        console.log('[Sleep] enterSleep blocked: in conversation mode');
        return;
    }
    console.log('[Sleep] >>> ENTERING SLEEP');
    STATE.sleeping = true;
    body.classList.add('sleeping');
    clearTimeout(sleepTimer);
    sleepTimer = null;
    stopAllTTS();
    STATE.presenceDetected = false;
    hideDonationQr();
    subtitleEl.classList.remove('visible');
    setExpression('idle', { force: true, skipHold: true });
    resetGaze();
    if (shouldSync) syncSleepState(true);
    logChat('sys', '💤 Sleep mode');
}

export function exitSleep(options = {}) {
    const shouldSync = options.sync !== false;
    if (!STATE.sleeping) {
        console.log('[Sleep] exitSleep blocked: not sleeping');
        return;
    }
    console.log('[Sleep] >>> EXITING SLEEP');
    STATE.sleeping = false;
    body.classList.remove('sleeping');
    STATE.wakeTime = Date.now();
    STATE.lastActivity = Date.now();
    $('#stat-awake').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

    logChat('sys', '☀️ Awake!');
    setExpression('idle', { force: true, skipHold: true });
    resetSleepTimer();
    if (shouldSync) syncSleepState(false);
    triggerBlink();
}

export function initSleepSlider() {
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
}
