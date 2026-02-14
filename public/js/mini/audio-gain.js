export function createMiniAudioGainController() {
    let audioCtx = null;
    let sourceNode = null;
    let gainNode = null;

    function clampGain(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return 1.0;
        return Math.max(0, Math.min(1.2, parsed));
    }

    function disconnect() {
        if (sourceNode) {
            try {
                sourceNode.disconnect();
            } catch {
                // ignore
            }
            sourceNode = null;
        }
        if (gainNode) {
            try {
                gainNode.disconnect();
            } catch {
                // ignore
            }
            gainNode = null;
        }
    }

    function apply(audioEl, gainValue) {
        if (!audioEl) return;
        const safeGain = clampGain(gainValue);
        disconnect();

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            audioEl.volume = Math.max(0, Math.min(1, safeGain));
            return;
        }

        try {
            if (!audioCtx) {
                audioCtx = new AudioCtx();
            }
            const source = audioCtx.createMediaElementSource(audioEl);
            const nextGainNode = audioCtx.createGain();
            nextGainNode.gain.value = safeGain;
            source.connect(nextGainNode);
            nextGainNode.connect(audioCtx.destination);
            sourceNode = source;
            gainNode = nextGainNode;
            audioEl.volume = 1;
            if (audioCtx.state === 'suspended') {
                void audioCtx.resume().catch(() => {
                    // Autoplay policies can block context resume. Fall back to native volume.
                    disconnect();
                    audioEl.volume = Math.max(0, Math.min(1, safeGain));
                });
            }
        } catch {
            // Fallback for browsers that reject media source wiring.
            audioEl.volume = Math.max(0, Math.min(1, safeGain));
        }
    }

    return {
        clampGain,
        disconnect,
        apply,
    };
}
