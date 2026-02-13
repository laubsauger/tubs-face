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

export function initFullscreenToggle(options = {}) {
    const onToggleRequested = typeof options.onToggleRequested === 'function'
        ? options.onToggleRequested
        : null;
    const onStateChanged = typeof options.onStateChanged === 'function'
        ? options.onStateChanged
        : null;
    const toggle = document.getElementById('fullscreen-toggle');
    if (!toggle) return;

    const emitState = () => {
        if (onStateChanged) {
            onStateChanged(isFullscreenActive());
        }
    };

    const handleChange = async () => {
        const requested = Boolean(toggle.checked);
        if (onToggleRequested) {
            onToggleRequested(requested);
        }
        try {
            await setFullscreenEnabled(requested);
        } catch (err) {
            updateToggle();
            emitState();
            logChat('sys', `Fullscreen unavailable: ${err.message}`);
        }
    };

    toggle.addEventListener('change', handleChange);
    document.addEventListener('fullscreenchange', () => {
        updateToggle();
        emitState();
    });
    document.addEventListener('webkitfullscreenchange', () => {
        updateToggle();
        emitState();
    });
    updateToggle();
    emitState();
}
