import { logChat } from './chat-log.js';

function isFullscreenActive() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function updateToggle() {
    const toggle = document.getElementById('fullscreen-toggle');
    if (!toggle) return;
    toggle.checked = isFullscreenActive();
}

async function requestAppFullscreen() {
    const root = document.documentElement;
    if (root.requestFullscreen) {
        await root.requestFullscreen();
        return;
    }
    if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
        return;
    }
    throw new Error('Fullscreen API unavailable');
}

async function exitAppFullscreen() {
    if (document.exitFullscreen) {
        await document.exitFullscreen();
        return;
    }
    if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
        return;
    }
    throw new Error('Fullscreen API unavailable');
}

export async function setFullscreenEnabled(enabled) {
    const shouldEnable = Boolean(enabled);
    const active = isFullscreenActive();
    if (shouldEnable === active) return;

    if (shouldEnable) {
        await requestAppFullscreen();
    } else {
        await exitAppFullscreen();
    }
}

export function initFullscreenToggle() {
    const toggle = document.getElementById('fullscreen-toggle');
    if (!toggle) return;

    const handleChange = async () => {
        try {
            await setFullscreenEnabled(toggle.checked);
        } catch (err) {
            updateToggle();
            logChat('sys', `Fullscreen unavailable: ${err.message}`);
        }
    };

    toggle.addEventListener('change', handleChange);
    document.addEventListener('fullscreenchange', updateToggle);
    document.addEventListener('webkitfullscreenchange', updateToggle);
    updateToggle();
}
