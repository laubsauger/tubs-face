import { STATE } from './state.js';
import { $, body, subtitleEl } from './dom.js';
import { logChat } from './chat-log.js';
import { setExpression, triggerBlink } from './expressions.js';
import { resetGaze } from './eye-tracking.js';
import { hideDonationQr } from './donation-ui.js';

let sleepTimer = null;

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
            } else {
                resetSleepTimer();
            }
        }, remaining);
    }
}

export function enterSleep() {
    if (STATE.sleeping) {
        console.log('[Sleep] enterSleep blocked: already sleeping');
        return;
    }
    if (STATE.facesDetected > 0) {
        console.log('[Sleep] enterSleep blocked: facesDetected=' + STATE.facesDetected);
        return;
    }
    console.log('[Sleep] >>> ENTERING SLEEP');
    STATE.sleeping = true;
    body.classList.add('sleeping');
    clearTimeout(sleepTimer);
    sleepTimer = null;
    speechSynthesis?.cancel();
    STATE.ttsQueue = [];
    STATE.speaking = false;
    STATE.presenceDetected = false;
    hideDonationQr();
    subtitleEl.classList.remove('visible');
    setExpression('idle', { force: true, skipHold: true });
    resetGaze();
    logChat('sys', '💤 Sleep mode');
}

export function exitSleep() {
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

    document.querySelectorAll('.panel').forEach((p, i) => {
        p.style.opacity = '0';
        setTimeout(() => { p.style.opacity = ''; }, 100 + i * 200);
    });

    logChat('sys', '☀️ Awake!');
    resetSleepTimer();
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
