export function fallbackToCanvas2D(args: {
  reason?: string;
  state: { kind: 'webgpu' | 'canvas2d'; ready: boolean; backendError: string; initPromise: Promise<boolean> | null; webGpuRetryDisabled: boolean };
  recreateCanvasElement: () => void;
  resetWebGpuResources: () => void;
  initCanvas2DRenderer: () => boolean;
  sizeCanvas: () => void;
  buildPixelGrid: () => void;
  setBackendStatus: () => void;
}): boolean {
  const {
    reason = 'fallback',
    state,
    recreateCanvasElement,
    resetWebGpuResources,
    initCanvas2DRenderer,
    sizeCanvas,
    buildPixelGrid,
    setBackendStatus,
  } = args;
  console.warn(`[GlitchFX] Switching to Canvas2D (${reason})`);
  resetWebGpuResources();
  recreateCanvasElement();
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

export async function initializeRendererBackend(args: {
  state: { kind: 'webgpu' | 'canvas2d'; ready: boolean; backendError: string; initPromise: Promise<boolean> | null; webGpuRetryDisabled: boolean };
  preferredRenderer: 'webgpu' | 'canvas2d' | 'auto';
  initWebGpuRenderer: () => Promise<boolean>;
  recreateCanvasElement: () => void;
  resetWebGpuResources: () => void;
  initCanvas2DRenderer: () => boolean;
  sizeCanvas: () => void;
  buildPixelGrid: () => void;
  setBackendStatus: () => void;
  setGlitchVisualActive: (active: boolean) => void;
}): Promise<void> {
  const {
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
  } = args;

  state.ready = false;
  state.backendError = '';
  setBackendStatus();

  const shouldTryWebGpu = (preferredRenderer === 'auto' || preferredRenderer === 'webgpu') && !state.webGpuRetryDisabled;
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
    state.webGpuRetryDisabled = true;
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

export function ensureRendererBackendReady(args: {
  state: { kind: 'webgpu' | 'canvas2d'; ready: boolean; backendError: string; initPromise: Promise<boolean> | null; webGpuRetryDisabled: boolean };
  initializeRendererBackend: () => Promise<void>;
  setBackendStatus: () => void;
}): Promise<boolean> {
  const { state, initializeRendererBackend, setBackendStatus } = args;
  if (state.ready) return Promise.resolve(true);

  if (!state.initPromise) {
    state.initPromise = initializeRendererBackend()
      .then(() => state.ready)
      .catch((error) => {
        console.error('[GlitchFX] Renderer init error:', error);
        state.ready = false;
        state.backendError = 'init-error';
        setBackendStatus();
        return false;
      });
  }

  return state.initPromise;
}
