import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEBGPU_INIT_TIMEOUT_MS, initializeRendererBackend } from './renderer-backend.js';

// The glitch canvas is the whole face. If renderer setup never finishes, the
// display shows no face at all, so a stuck WebGPU init must end in Canvas2D.
function setup(initWebGpuRenderer: () => Promise<boolean>) {
  const state = { kind: 'canvas2d' as 'webgpu' | 'canvas2d', ready: false, backendError: '', initPromise: null, webGpuRetryDisabled: false };
  const calls = {
    recreateCanvasElement: vi.fn(),
    resetWebGpuResources: vi.fn(),
    initCanvas2DRenderer: vi.fn(() => true),
  };
  const run = initializeRendererBackend({
    state,
    preferredRenderer: 'auto',
    initWebGpuRenderer,
    ...calls,
    sizeCanvas: () => {},
    buildPixelGrid: () => {},
    setBackendStatus: () => {},
    setGlitchVisualActive: () => {},
  });
  return { state, calls, run };
}

describe('initializeRendererBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses WebGPU when it initializes in time', async () => {
    const { state, calls, run } = setup(async () => true);
    await run;
    expect(state).toMatchObject({ kind: 'webgpu', ready: true });
    expect(calls.initCanvas2DRenderer).not.toHaveBeenCalled();
  });

  it('falls back to Canvas2D on a fresh canvas when WebGPU init hangs', async () => {
    const { state, calls, run } = setup(() => new Promise<boolean>(() => {}));
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS);
    await run;
    expect(state).toMatchObject({ kind: 'canvas2d', ready: true, webGpuRetryDisabled: true });
    // The canvas already has a webgpu context; a 2d context needs a new element.
    expect(calls.recreateCanvasElement).toHaveBeenCalled();
    expect(calls.initCanvas2DRenderer).toHaveBeenCalled();
  });

  it('releases the WebGPU device if init finishes after the fallback', async () => {
    let finish!: (ok: boolean) => void;
    const { state, calls, run } = setup(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS);
    await run;
    calls.resetWebGpuResources.mockClear();
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.resetWebGpuResources).toHaveBeenCalledTimes(1);
    expect(state.kind).toBe('canvas2d');
  });

  it('falls back to Canvas2D when WebGPU init throws', async () => {
    const { state, run } = setup(async () => {
      throw new Error('device creation failed');
    });
    await run;
    expect(state).toMatchObject({ kind: 'canvas2d', ready: true });
  });
});
