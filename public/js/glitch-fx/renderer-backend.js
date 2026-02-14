export function fallbackToCanvas2D({
    reason = 'fallback',
    state,
    resetWebGpuResources,
    initCanvas2DRenderer,
    sizeCanvas,
    buildPixelGrid,
    setBackendStatus,
}) {
    console.warn(`[GlitchFX] Switching to Canvas2D (${reason})`);
    resetWebGpuResources();
    state.kind = 'canvas2d';
    state.ready = false;
    state.backendError = '';

    if (!initCanvas2DRenderer()) {
        state.backendError = 'no-renderer';
        state.ready = false;
        setBackendStatus();
        return false;
    }

    state.ready = true;
    sizeCanvas();
    buildPixelGrid();
    setBackendStatus();
    return true;
}

export async function initializeRendererBackend({
    state,
    preferredRenderer,
    initWebGpuRenderer,
    recreateCanvasElement,
    resetWebGpuResources,
    initCanvas2DRenderer,
    sizeCanvas,
    buildPixelGrid,
    setBackendStatus,
    setGlitchVisualActive,
}) {
    state.ready = false;
    state.backendError = '';
    setBackendStatus();

    const shouldTryWebGpu = preferredRenderer === 'auto' || preferredRenderer === 'webgpu';

    if (shouldTryWebGpu) {
        const ok = await initWebGpuRenderer();
        if (ok) {
            state.kind = 'webgpu';
            state.ready = true;
            sizeCanvas();
            buildPixelGrid();
            setBackendStatus();
            return;
        }

        recreateCanvasElement();
    }

    resetWebGpuResources();

    if (!initCanvas2DRenderer()) {
        console.error('[GlitchFX] Unable to initialize any renderer backend.');
        state.kind = 'canvas2d';
        state.ready = false;
        state.backendError = 'no-renderer';
        setGlitchVisualActive(false);
        setBackendStatus();
        return;
    }

    state.kind = 'canvas2d';
    state.ready = true;
    sizeCanvas();
    buildPixelGrid();
    setBackendStatus();
}

export function ensureRendererBackendReady({
    state,
    initializeRendererBackend,
    setBackendStatus,
}) {
    if (state.ready) return Promise.resolve(true);

    if (!state.initPromise) {
        state.initPromise = initializeRendererBackend().then(() => state.ready).catch((err) => {
            console.error('[GlitchFX] Renderer init error:', err);
            state.ready = false;
            state.backendError = 'init-error';
            setBackendStatus();
            return false;
        });
    }

    return state.initPromise;
}
