import type { AppStore } from '../state/app-state.js';
import { DEFAULT_CONFIG, GAZE_LERP, SPEAK_CYCLE_MS, SPEAK_MAX_SCALE, SPEAK_MIN_SCALE, setExpressionProfiles, type GlitchConfig } from './constants.js';
import { rebuildScanlinePattern, initCanvas2DRenderer, recreateCanvasElement, sizeCanvasLayout } from './canvas2d.js';
import { computeFrameState, renderFrameCanvas2D, renderFrameWebGpu } from './frame.js';
import { buildPixelGrid, featureFitScale, recolorPixelGrid, type PixelGridPoint, type ShapeCenter } from './pixel-grid.js';
import { ensureRendererBackendReady, initializeRendererBackend } from './renderer-backend.js';
import { createWebGpuState, configureWebGpuCanvas, initWebGpuRenderer, resetWebGpuResources, updateGpuInstanceBuffer, type WebGpuState } from './webgpu.js';
import { hexToHSL, mergeConfig, normalizeRenderer } from './utils.js';
import { readSpeechLevel } from '../audio/speech-level.js';
import { NEUTRAL_TINT, moodTint } from './mood-tint.js';

export interface GlitchRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  dispose(): void;
}

interface RendererState {
  kind: 'webgpu' | 'canvas2d';
  ready: boolean;
  initPromise: Promise<boolean> | null;
  backendError: string;
  webGpuRetryDisabled: boolean;
}

export function createGlitchRuntime(store: AppStore, mode: 'main' | 'mini'): GlitchRuntime {
  let faceEl: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let tempCanvas: HTMLCanvasElement | null = null;
  let tempCtx: CanvasRenderingContext2D | null = null;
  let scanlinePattern: CanvasPattern | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: number | null = null;
  let animFrameId: number | null = null;
  let startTime = performance.now();
  let baseHSL = hexToHSL(DEFAULT_CONFIG.color.base);
  // Colours currently baked into the Canvas2D pixel grid (WebGPU tints per frame).
  let bakedHSL = baseHSL;
  let cachedDpr = 1;
  let cachedGlowFilter = 'blur(14px)';
  let cachedScanBeamRGBA = 'rgba(166,0,255,0.26)';
  let containerCssW = 0;
  let containerCssH = 0;
  let effectivePixelSize = DEFAULT_CONFIG.pixel.size;
  let effectivePixelGap = DEFAULT_CONFIG.pixel.gap;
  let pixelGrid: PixelGridPoint[] = [];
  let shapeGroups: number[] = [];
  let shapeCenters: ShapeCenter[] = [];
  let lastBuiltExpression = '';
  let lastSleepingState = false;
  let lastBurstState = false;
  let glitchBurstSeed = Math.random() * 1000;
  let currentGazeX = 0;
  let currentGazeY = 0;
  let rendererConfig: GlitchConfig = structuredClone(DEFAULT_CONFIG);
  let lastRendererPreference = normalizeRenderer(DEFAULT_CONFIG.renderer);
  let lastProfileSignature = '';
  let lastRendererSignature = '';
  const rendererState: RendererState = {
    kind: 'canvas2d',
    ready: false,
    initPromise: null,
    backendError: '',
    webGpuRetryDisabled: false,
  };
  const gpu: WebGpuState = createWebGpuState();
  const colorLUTs = new Map<number, string[]>();

  return {
    init(): void {
      startTime = performance.now();
      syncConfig();
    },
    bind(root: HTMLElement): void {
      const nextFace = root.querySelector<HTMLElement>('#visual-face');
      if (nextFace !== faceEl) {
        teardownResize();
        faceEl = nextFace;
        canvas = null;
        ctx = null;
        tempCanvas = null;
        tempCtx = null;
        scanlinePattern = null;
        rendererState.ready = false;
        rendererState.initPromise = null;
        rendererState.webGpuRetryDisabled = false;
        setupCanvas();
        setupResize();
      }

      syncConfig();
      if (!faceEl) {
        stopRenderLoop();
        setCanvasVisible(false);
        return;
      }

      void ensureRendererReady().then((ok) => {
        if (ok) {
          startRenderLoop();
        }
      });
    },
    dispose(): void {
      stopRenderLoop();
      teardownResize();
      resetWebGpuResources(gpu);
    },
  };

  function syncConfig(): void {
    const state = store.getState();
    const config = state.config;
    const nextProfiles = config?.glitchExpressionProfiles;
    if (nextProfiles) {
      const signature = JSON.stringify(nextProfiles);
      if (signature !== lastProfileSignature) {
        lastProfileSignature = signature;
        setExpressionProfiles(structuredClone(nextProfiles));
        lastBuiltExpression = '';
      }
    }
    rendererConfig = mergeConfig(DEFAULT_CONFIG);
    rendererConfig.renderer = config?.glitchRenderer ?? DEFAULT_CONFIG.renderer;
    rendererConfig.color.base = mode === 'mini'
      ? (config?.secondaryGlitchFxBaseColor ?? config?.glitchFxBaseColor ?? state.fxBaseColorDraft)
      : (config?.glitchFxBaseColor ?? state.fxBaseColorDraft);
    rendererConfig.pixel.size = config?.glitchPixelSize ?? DEFAULT_CONFIG.pixel.size;
    rendererConfig.pixel.gap = config?.glitchPixelGap ?? DEFAULT_CONFIG.pixel.gap;
    rendererConfig.color.hueVariation = config?.glitchColorHueVariation ?? DEFAULT_CONFIG.color.hueVariation;
    rendererConfig.color.brightnessVariation = config?.glitchColorBrightnessVariation ?? DEFAULT_CONFIG.color.brightnessVariation;
    rendererConfig.color.opacityMin = config?.glitchColorOpacityMin ?? DEFAULT_CONFIG.color.opacityMin;
    rendererConfig.glow.pixelGlow = config?.glitchGlowStrength ?? DEFAULT_CONFIG.glow.pixelGlow;
    rendererConfig.svg.shapes[0] = {
      x: config?.glitchShapeLeftEyeX ?? DEFAULT_CONFIG.svg.shapes[0]?.x ?? 0,
      y: config?.glitchShapeLeftEyeY ?? DEFAULT_CONFIG.svg.shapes[0]?.y ?? 0,
      w: config?.glitchShapeLeftEyeW ?? DEFAULT_CONFIG.svg.shapes[0]?.w ?? 14.59,
      h: config?.glitchShapeLeftEyeH ?? DEFAULT_CONFIG.svg.shapes[0]?.h ?? 22.47,
      rx: config?.glitchShapeLeftEyeRx ?? DEFAULT_CONFIG.svg.shapes[0]?.rx ?? 5.94,
      ry: config?.glitchShapeLeftEyeRy ?? DEFAULT_CONFIG.svg.shapes[0]?.ry ?? 5.94,
    };
    rendererConfig.svg.shapes[1] = {
      x: config?.glitchShapeRightEyeX ?? DEFAULT_CONFIG.svg.shapes[1]?.x ?? 40.85,
      y: config?.glitchShapeRightEyeY ?? DEFAULT_CONFIG.svg.shapes[1]?.y ?? 0,
      w: config?.glitchShapeRightEyeW ?? DEFAULT_CONFIG.svg.shapes[1]?.w ?? 14.59,
      h: config?.glitchShapeRightEyeH ?? DEFAULT_CONFIG.svg.shapes[1]?.h ?? 22.47,
      rx: config?.glitchShapeRightEyeRx ?? DEFAULT_CONFIG.svg.shapes[1]?.rx ?? 5.94,
      ry: config?.glitchShapeRightEyeRy ?? DEFAULT_CONFIG.svg.shapes[1]?.ry ?? 5.94,
    };
    rendererConfig.svg.shapes[2] = {
      x: config?.glitchShapeMouthX ?? DEFAULT_CONFIG.svg.shapes[2]?.x ?? 20.53,
      y: config?.glitchShapeMouthY ?? DEFAULT_CONFIG.svg.shapes[2]?.y ?? 23.86,
      w: config?.glitchShapeMouthW ?? DEFAULT_CONFIG.svg.shapes[2]?.w ?? 14.38,
      h: config?.glitchShapeMouthH ?? DEFAULT_CONFIG.svg.shapes[2]?.h ?? 6.44,
      rx: config?.glitchShapeMouthRx ?? DEFAULT_CONFIG.svg.shapes[2]?.rx ?? 1.95,
      ry: config?.glitchShapeMouthRy ?? DEFAULT_CONFIG.svg.shapes[2]?.ry ?? 1.95,
    };
    rendererConfig.brightnessPulse.enabled = config?.glitchBrightnessPulseEnabled ?? DEFAULT_CONFIG.brightnessPulse.enabled;
    rendererConfig.brightnessPulse.dim = config?.glitchBrightnessPulseDim ?? DEFAULT_CONFIG.brightnessPulse.dim;
    rendererConfig.brightnessPulse.bright = config?.glitchBrightnessPulseBright ?? DEFAULT_CONFIG.brightnessPulse.bright;
    rendererConfig.brightnessPulse.speed = config?.glitchBrightnessPulseSpeed ?? DEFAULT_CONFIG.brightnessPulse.speed;
    rendererConfig.scanBeam.enabled = config?.glitchScanBeamEnabled ?? DEFAULT_CONFIG.scanBeam.enabled;
    rendererConfig.scanBeam.speed = config?.glitchScanBeamSpeed ?? DEFAULT_CONFIG.scanBeam.speed;
    rendererConfig.scanBeam.lineWidth = config?.glitchScanBeamLineWidth ?? DEFAULT_CONFIG.scanBeam.lineWidth;
    rendererConfig.scanBeam.brightness = config?.glitchScanBeamBrightness ?? DEFAULT_CONFIG.scanBeam.brightness;
    rendererConfig.scanBeam.glowStrength = config?.glitchScanBeamGlowStrength ?? DEFAULT_CONFIG.scanBeam.glowStrength;
    rendererConfig.scanBeam.jitter = config?.glitchScanBeamJitter ?? DEFAULT_CONFIG.scanBeam.jitter;
    rendererConfig.scanBeam.color = config?.glitchScanBeamColor ?? DEFAULT_CONFIG.scanBeam.color;
    rendererConfig.chromatic.enabled = config?.glitchChromaticEnabled ?? DEFAULT_CONFIG.chromatic.enabled;
    rendererConfig.chromatic.offsetX = config?.glitchChromaticOffsetX ?? DEFAULT_CONFIG.chromatic.offsetX;
    rendererConfig.chromatic.offsetY = config?.glitchChromaticOffsetY ?? DEFAULT_CONFIG.chromatic.offsetY;
    rendererConfig.chromatic.intensity = config?.glitchChromaticIntensity ?? DEFAULT_CONFIG.chromatic.intensity;
    rendererConfig.chromatic.animate = config?.glitchChromaticAnimate ?? DEFAULT_CONFIG.chromatic.animate;
    rendererConfig.chromatic.animateSpeed = config?.glitchChromaticAnimateSpeed ?? DEFAULT_CONFIG.chromatic.animateSpeed;
    rendererConfig.glitchSlice.enabled = config?.glitchSliceEnabled ?? DEFAULT_CONFIG.glitchSlice.enabled;
    rendererConfig.glitchSlice.sliceCount = config?.glitchSliceCount ?? DEFAULT_CONFIG.glitchSlice.sliceCount;
    rendererConfig.glitchSlice.maxOffset = config?.glitchSliceMaxOffset ?? DEFAULT_CONFIG.glitchSlice.maxOffset;
    rendererConfig.glitchSlice.speed = config?.glitchSliceSpeed ?? DEFAULT_CONFIG.glitchSlice.speed;
    rendererConfig.glitchSlice.intensity = config?.glitchSliceIntensity ?? DEFAULT_CONFIG.glitchSlice.intensity;
    rendererConfig.glitchSlice.colorShift = config?.glitchSliceColorShift ?? DEFAULT_CONFIG.glitchSlice.colorShift;
    rendererConfig.glitchSlice.gapChance = config?.glitchSliceGapChance ?? DEFAULT_CONFIG.glitchSlice.gapChance;
    rendererConfig.glitchSlice.interval = config?.glitchSliceIntervalMs ?? DEFAULT_CONFIG.glitchSlice.interval;
    rendererConfig.glitchSlice.burstDuration = config?.glitchSliceBurstDurationMs ?? DEFAULT_CONFIG.glitchSlice.burstDuration;
    rendererConfig.glitch.scanlines = config?.glitchScanlines ?? DEFAULT_CONFIG.glitch.scanlines;
    rendererConfig.glitch.scanlineIntensity = config?.glitchScanlineIntensity ?? DEFAULT_CONFIG.glitch.scanlineIntensity;
    rendererConfig.glitch.scanlineSpacing = config?.glitchScanlineSpacing ?? DEFAULT_CONFIG.glitch.scanlineSpacing;
    rendererConfig.glitch.scanlineThickness = config?.glitchScanlineThickness ?? DEFAULT_CONFIG.glitch.scanlineThickness;
    rendererConfig.glitch.scanlineMove = (config?.glitchScanlineSpeed ?? DEFAULT_CONFIG.glitch.scanlineSpeed) > 0;
    rendererConfig.glitch.scanlineSpeed = config?.glitchScanlineSpeed ?? DEFAULT_CONFIG.glitch.scanlineSpeed;
    rendererConfig.glitch.pixelJitter = config?.glitchPixelJitter ?? DEFAULT_CONFIG.glitch.pixelJitter;
    rendererConfig.glitch.flicker = config?.glitchFlicker ?? DEFAULT_CONFIG.glitch.flicker;
    rendererConfig.glitch.flickerSpeed = config?.glitchFlickerSpeed ?? DEFAULT_CONFIG.glitch.flickerSpeed;
    rendererConfig.glitch.flickerDepth = config?.glitchFlickerDepth ?? DEFAULT_CONFIG.glitch.flickerDepth;
    // Glitch FX off: draw the same pixel face, just without the effects. It
    // used to stop the renderer, which left no face on screen at all.
    if (config && !config.glitchFxEnabled) {
      rendererConfig.glitch.scanlines = false;
      rendererConfig.glitch.flicker = false;
      rendererConfig.glitch.pixelJitter = 0;
      rendererConfig.glitch.scanlineMove = false;
      rendererConfig.chromatic.enabled = false;
      rendererConfig.glitchSlice.enabled = false;
      rendererConfig.scanBeam.enabled = false;
      rendererConfig.brightnessPulse.enabled = false;
    }
    const nextRendererPreference = normalizeRenderer(rendererConfig.renderer);
    if (nextRendererPreference !== lastRendererPreference) {
      lastRendererPreference = nextRendererPreference;
      resetRendererBackend();
    }
    baseHSL = hexToHSL(rendererConfig.color.base);
    const scan = hexToHSL(rendererConfig.scanBeam.color);
    cachedScanBeamRGBA = `rgba(${scan.h},${scan.s},${scan.l},0.26)`;
    recolorPixelGrid(pixelGrid, colorLUTs, baseHSL);
    bakedHSL = baseHSL;

    const rendererSignature = JSON.stringify(rendererConfig);
    if (rendererSignature !== lastRendererSignature) {
      const firstSync = lastRendererSignature === '';
      lastRendererSignature = rendererSignature;
      if (!firstSync) {
        applyRendererConfigChange();
      }
    }
  }

  /**
   * Pixel size, gap, shapes, scanlines and glow are baked into the pixel grid and
   * the Canvas2D caches when the canvas is sized. Rebuild them so FX editor
   * changes show up live instead of on the next resize or expression change.
   */
  function applyRendererConfigChange(): void {
    if (!rendererState.ready) {
      return;
    }
    updateEffectivePixelMetrics();
    if (ctx) {
      scanlinePattern = rebuildScanlinePattern(ctx, rendererConfig, cachedDpr);
    }
    cachedGlowFilter = `blur(${Math.round(rendererConfig.glow.pixelGlow * cachedDpr)}px)`;
    lastBuiltExpression = '';
  }

  function setupCanvas(): void {
    if (!faceEl) return;
    let nextCanvas = faceEl.querySelector<HTMLCanvasElement>('.glitch-face-canvas');
    if (!nextCanvas) {
      nextCanvas = document.createElement('canvas');
      nextCanvas.className = 'glitch-face-canvas';
      nextCanvas.id = 'glitch-face-canvas';
      faceEl.appendChild(nextCanvas);
    }
    canvas = nextCanvas;
  }

  function setupResize(): void {
    if (!faceEl) return;
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer != null) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        sizeCanvas();
        buildGrid();
      }, 80);
    });
    resizeObserver.observe(faceEl);
  }

  function teardownResize(): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (resizeTimer != null) {
      window.clearTimeout(resizeTimer);
      resizeTimer = null;
    }
  }

  function setCanvasVisible(active: boolean): void {
    if (faceEl) {
      faceEl.classList.toggle('is-glitch-active', active);
    }
    if (!canvas) return;
    canvas.style.display = active ? 'block' : 'none';
  }

  function sizeCanvas(): void {
    if (!faceEl || !canvas) return;
    updateEffectivePixelMetrics();
    const next = sizeCanvasLayout({
      containerEl: faceEl,
      canvas,
      config: rendererConfig,
      rendererKind: rendererState.kind,
      ctx,
      tempCanvas,
      tempCtx,
      scanlinePattern,
      configureWebGpuCanvas: () => configureWebGpuCanvas(gpu, canvas),
    });
    if (!next) return;
    containerCssW = next.containerCssW;
    containerCssH = next.containerCssH;
    cachedDpr = next.cachedDpr;
    cachedGlowFilter = next.cachedGlowFilter;
    tempCanvas = next.tempCanvas;
    tempCtx = next.tempCtx;
    scanlinePattern = next.scanlinePattern;
  }

  function updateEffectivePixelMetrics(): void {
    if (!faceEl) return;
    const rect = faceEl.getBoundingClientRect();
    // Scale pixels with the box the features are fitted into, not the raw
    // width: in a wide, short window the face fits the height and full-size
    // pixels would leave it a handful of chunky blocks.
    const vb = rendererConfig.svg.viewBox;
    const featureBoxWidth = vb.w * featureFitScale(rect.width, rect.height, vb);
    const scale = Math.max(0.16, Math.min(1.0, featureBoxWidth / 1400));
    effectivePixelSize = Math.max(2, rendererConfig.pixel.size * scale);
    effectivePixelGap = Math.max(0, rendererConfig.pixel.gap * scale);
  }

  function buildGrid(): void {
    if (!faceEl) return;
    const rect = faceEl.getBoundingClientRect();
    const next = buildPixelGrid(
      store.getState(),
      rendererConfig,
      rect.width,
      rect.height,
      effectivePixelSize,
      effectivePixelGap,
      baseHSL,
      colorLUTs,
    );
    pixelGrid = next.pixelGrid;
    shapeGroups = next.shapeGroups;
    shapeCenters = next.shapeCenters;
    lastBuiltExpression = store.getState().currentExpression;
    lastSleepingState = store.getState().sleeping;
    bakedHSL = baseHSL;
    if (rendererState.kind === 'webgpu') {
      updateGpuInstanceBuffer(gpu, pixelGrid, shapeGroups);
    }
  }

  function initCanvasBackend(): boolean {
    const next = initCanvas2DRenderer(canvas, rendererConfig, cachedDpr);
    if (!next.ok) return false;
    ctx = next.ctx;
    tempCanvas = next.tempCanvas;
    tempCtx = next.tempCtx;
    scanlinePattern = next.scanlinePattern;
    return true;
  }

  function resetGpu(): void {
    resetWebGpuResources(gpu);
  }

  function swapCanvas(): void {
    canvas = recreateCanvasElement(canvas);
  }

  function resetRendererBackend(): void {
    stopRenderLoop();
    rendererState.ready = false;
    rendererState.initPromise = null;
    rendererState.backendError = '';
    rendererState.webGpuRetryDisabled = false;
    rendererState.kind = 'canvas2d';
    ctx = null;
    tempCanvas = null;
    tempCtx = null;
    scanlinePattern = null;
    resetGpu();
    if (canvas) {
      swapCanvas();
    }
    publishBackend();
  }

  async function ensureRendererReady(): Promise<boolean> {
    return ensureRendererBackendReady({
      state: rendererState,
      initializeRendererBackend: async () => {
        await initializeRendererBackend({
          state: rendererState,
          preferredRenderer: normalizeRenderer(rendererConfig.renderer),
          initWebGpuRenderer: () => initWebGpuRenderer(gpu, canvas),
          recreateCanvasElement: swapCanvas,
          resetWebGpuResources: resetGpu,
          initCanvas2DRenderer: initCanvasBackend,
          sizeCanvas,
          buildPixelGrid: buildGrid,
          setBackendStatus: publishBackend,
          setGlitchVisualActive: setCanvasVisible,
        });
      },
      setBackendStatus: publishBackend,
    });
  }

  /** Shown in System Vitals, so a kiosk stuck on Canvas2D is visible at a glance. */
  function publishBackend(): void {
    const backend = rendererState.ready ? rendererState.kind : null;
    if (store.getState().glitchBackend !== backend) {
      store.setState((current) => ({ ...current, glitchBackend: backend }));
    }
  }

  function startRenderLoop(): void {
    if (animFrameId != null || !rendererState.ready) return;
    sizeCanvas();
    buildGrid();
    startTime = performance.now();
    animFrameId = requestAnimationFrame(renderFrame);
  }

  function stopRenderLoop(): void {
    if (animFrameId != null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  function renderFrame(now: number): void {
    animFrameId = requestAnimationFrame(renderFrame);
    const state = store.getState();
    if (!canvas || !faceEl) {
      stopRenderLoop();
      setCanvasVisible(false);
      return;
    }

    currentGazeX += (state.gazeX - currentGazeX) * GAZE_LERP;
    currentGazeY += (state.gazeY - currentGazeY) * GAZE_LERP;

    if (state.currentExpression !== lastBuiltExpression || state.sleeping !== lastSleepingState) {
      buildGrid();
    }

    // The face reads Tubs's mood; not while asleep or while the FX editor shows the true colours.
    const tint = state.sleeping || state.fxEditorOpen
      ? NEUTRAL_TINT
      : moodTint({ pos: state.moodPos, neg: state.moodNeg, arousal: state.moodArousal });
    const moodHSL = {
      h: baseHSL.h + tint.hueShift,
      s: Math.max(0, Math.min(100, baseHSL.s * tint.saturation)),
      l: Math.max(0, Math.min(100, baseHSL.l + tint.lightness)),
    };
    if (rendererState.kind !== 'webgpu'
      && (Math.abs(moodHSL.h - bakedHSL.h) >= 2 || Math.abs(moodHSL.s - bakedHSL.s) >= 2 || Math.abs(moodHSL.l - bakedHSL.l) >= 1)) {
      // Canvas2D bakes colours; re-bake only when the change is visible.
      recolorPixelGrid(pixelGrid, colorLUTs, moodHSL);
      bakedHSL = moodHSL;
    }

    const frameResult = computeFrameState(now, {
      state,
      tint,
      config: rendererConfig,
      startTime,
      cachedDpr,
      canvas,
      containerCssW,
      containerCssH,
      effectivePixelSize,
      currentGazeX,
      currentGazeY,
      faceW: faceEl.getBoundingClientRect().width,
      faceH: faceEl.getBoundingClientRect().height,
      getBlinkFactor,
      getSpeakMouthScale,
      lastBurstState,
      glitchBurstSeed,
    });
    lastBurstState = frameResult.lastBurstState;
    glitchBurstSeed = frameResult.glitchBurstSeed;

    let drawn = false;
    if (rendererState.kind === 'webgpu') {
      drawn = renderFrameWebGpu(frameResult.frame, {
        gpuDevice: gpu.gpuDevice,
        gpuContext: gpu.gpuContext,
        gpuPixelPipeline: gpu.gpuPixelPipeline,
        gpuPostPipeline: gpu.gpuPostPipeline,
        gpuPixelBindGroup: gpu.gpuPixelBindGroup,
        gpuPostBindGroup: gpu.gpuPostBindGroup,
        gpuSceneTextureView: gpu.gpuSceneTextureView,
        gpuInstanceCount: gpu.gpuInstanceCount,
        gpuUniformBuffer: gpu.gpuUniformBuffer,
        gpuPostUniformBuffer: gpu.gpuPostUniformBuffer,
        gpuUniformData: gpu.gpuUniformData,
        gpuPostUniformData: gpu.gpuPostUniformData,
        config: rendererConfig,
        faceW: faceEl.getBoundingClientRect().width,
        faceH: faceEl.getBoundingClientRect().height,
        shapeCenters,
        baseHSL: moodHSL,
        glitchBurstSeed,
        sleeping: state.sleeping,
      });
    } else {
      drawn = renderFrameCanvas2D(frameResult.frame, {
        canvas,
        ctx,
        tempCtx,
        tempCanvas,
        config: rendererConfig,
        baseHSL: moodHSL,
        pixelGrid,
        shapeGroups,
        shapeCenters,
        cachedGlowFilter,
        cachedScanBeamRGBA,
        scanlinePattern,
      });
    }

    // If WebGPU simply skipped rendering (for size recalculations, etc.),
    // ensure we don't brutally crash and hide the DOM element
    setCanvasVisible(rendererState.kind === 'webgpu' || drawn);
  }

  function getBlinkFactor(): number {
    return Math.max(blinkAmount(), moodSquint());
  }

  function blinkAmount(): number {
    const lastBlinkAt = store.getState().lastBlinkAt;
    if (!store.getState().blinkActive || !lastBlinkAt) return 0;
    // lastBlinkAt is Date.now(); the frame clock is performance.now(). Mixing
    // them made elapsed hugely negative and the pixel face never blinked.
    const elapsed = Date.now() - lastBlinkAt;
    if (elapsed < 80) return elapsed / 80;
    if (elapsed < 140) return 1;
    if (elapsed < 220) return 1 - (elapsed - 140) / 80;
    return 0;
  }

  /** Annoyed and worked up, the eyes narrow; more so the longer it lasts. */
  function moodSquint(): number {
    const state = store.getState();
    if (state.sleeping) return 0;
    return Math.min(0.3, Math.max(0, 1.2 * (state.moodNeg - 0.1) * (0.6 + state.moodArousal)));
  }

  function getSpeakMouthScale(now: number): number {
    const state = store.getState();
    if (!state.audioPlaying) return 1;
    // Worked up, the mouth moves bigger; flat, it barely opens.
    const range = (SPEAK_MAX_SCALE - SPEAK_MIN_SCALE) * (0.75 + 0.5 * state.moodArousal);
    const level = readSpeechLevel(now);
    if (level !== null) {
      return SPEAK_MIN_SCALE + range * level;
    }
    const phase = ((now - startTime) % SPEAK_CYCLE_MS) / SPEAK_CYCLE_MS;
    return SPEAK_MIN_SCALE + range * (0.5 + 0.5 * Math.sin(phase * Math.PI * 2));
  }
}
