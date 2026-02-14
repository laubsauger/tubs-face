function readFullscreenIntent(storageKey) {
    try {
        return localStorage.getItem(storageKey) === '1';
    } catch {
        return false;
    }
}

function isFullscreenActive() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

async function requestFullscreen() {
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

async function exitFullscreen() {
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

export function createMiniFullscreenSync({
    storageKey,
    messageType,
    logPrefix = '[MINI]',
} = {}) {
    let desired = false;
    let pending = false;

    async function apply(reason = 'sync') {
        const active = isFullscreenActive();
        if (desired === active) {
            pending = false;
            return;
        }

        if (!desired) {
            pending = false;
            try {
                await exitFullscreen();
            } catch {
                // ignore
            }
            return;
        }

        try {
            await requestFullscreen();
            pending = false;
        } catch (err) {
            pending = true;
            console.log(`${logPrefix} fullscreen deferred (${reason}): ${err?.message || 'request failed'}`);
        }
    }

    function init() {
        desired = readFullscreenIntent(storageKey);

        window.addEventListener('message', (event) => {
            if (event.origin !== location.origin) return;
            const msg = event?.data;
            if (!msg || msg.type !== messageType) return;
            desired = Boolean(msg.enabled);
            void apply('postMessage');
        });

        window.addEventListener('storage', (event) => {
            if (event.key !== storageKey) return;
            desired = readFullscreenIntent(storageKey);
            void apply('storage');
        });

        const retryIfPending = () => {
            if (!pending || !desired) return;
            void apply('gesture');
        };

        window.addEventListener('pointerdown', retryIfPending, { passive: true });
        window.addEventListener('keydown', retryIfPending);
        window.addEventListener('focus', retryIfPending);

        document.addEventListener('fullscreenchange', () => {
            if (desired && !isFullscreenActive()) {
                pending = true;
            }
        });
        document.addEventListener('webkitfullscreenchange', () => {
            if (desired && !isFullscreenActive()) {
                pending = true;
            }
        });

        if (desired) {
            setTimeout(() => {
                void apply('init');
            }, 120);
        }
    }

    return {
        init,
        apply,
    };
}
