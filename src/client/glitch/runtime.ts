import type { ExpressionName } from '../../shared/contracts/config.js';
import type { AppState, AppStore } from '../state/app-state.js';
import {
  DEFAULT_CONFIG,
  EXPRESSION_PROFILES,
  MORPH,
  MORPH_SLEEP,
  MORPH_WAKE,
  SPEAK_CYCLE_MS,
  SPEAK_MAX_SCALE,
  SPEAK_MIN_SCALE,
  setExpressionProfiles,
  type GlitchConfig,
} from './constants.js';
import { computeFrameState, renderFrameWebGpu } from './frame.js';
import { INSTANCE_FLOATS, createMorphPlan, easeOutCubic, packPixels, planMorph, snapshotMorph, writeMorphFrame } from './morph.js';
import { buildPixelGrid, featureFitScale, type PixelGridPoint, type ShapeCenter } from './pixel-grid.js';
import { createWebGpuState, configureWebGpuCanvas, initWebGpuRenderer, resetWebGpuResources, writeGpuInstances, type WebGpuState } from './webgpu.js';
import { hexToHSL, mergeConfig } from './utils.js';
import { readSpeechLevel } from '../audio/speech-level.js';
import { NEUTRAL_TINT, moodTint } from './mood-tint.js';

export interface GlitchRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  dispose(): void;
}

interface RendererState {
  ready: boolean;
  initPromise: Promise<boolean> | null;
}

export function createGlitchRuntime(store: AppStore, mode: 'main' | 'mini'): GlitchRuntime {
  let faceEl: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: number | null = null;
  let animFrameId: number | null = null;
  let startTime = performance.now();
  let baseHSL = hexToHSL(DEFAULT_CONFIG.color.base);
  let cachedDpr = 1;
  let containerCssW = 0;
  let containerCssH = 0;
  let effectivePixelSize = DEFAULT_CONFIG.pixel.size;
  let effectivePixelGap = DEFAULT_CONFIG.pixel.gap;
  // The grid of the expression on screen; during a morph, the one it morphs to.
  let pixelGrid: PixelGridPoint[] = [];
  let shapeCenters: ShapeCenter[] = [];
  // Centres the blink and speech mouth squash around; they travel with a morph.
  const drawnCenters: ShapeCenter[] = [{ cx: 0, cy: 0 }, { cx: 0, cy: 0 }, { cx: 0, cy: 0 }];
  const morphFromCenters: ShapeCenter[] = [{ cx: 0, cy: 0 }, { cx: 0, cy: 0 }, { cx: 0, cy: 0 }];
  const morph = createMorphPlan();
  let morphing = false;
  let morphStart = 0;
  let instanceData = new Float32Array(0);
  // Expression the grid was built for ('sleep' while asleep) and its profile.
  let builtFaceKey: ExpressionName | '' = '';
  let builtProfileSignature = '';
  // Pixel size, shapes or profiles changed: rebuild at once, no morph.
  let gridDirty = true;
  let lastBurstState = false;
  let glitchBurstSeed = Math.random() * 1000;
  let rendererConfig: GlitchConfig = structuredClone(DEFAULT_CONFIG);
  let lastProfileSignature = '';
  let lastRendererSignature = '';
  const rendererState: RendererState = { ready: false, initPromise: null };
  const gpu: WebGpuState = createWebGpuState();

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
        rendererState.ready = false;
        rendererState.initPromise = null;
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
        gridDirty = true;
      }
    }
    rendererConfig = mergeConfig(DEFAULT_CONFIG);
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
    baseHSL = hexToHSL(rendererConfig.color.base);

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
   * Pixel size, gap and shapes are baked into the pixel grid. Rebuild it so FX
   * editor changes show up live instead of on the next resize or expression change.
   */
  function applyRendererConfigChange(): void {
    if (!rendererState.ready) {
      return;
    }
    updateEffectivePixelMetrics();
    gridDirty = true;
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
    const rect = faceEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // The spectator page runs on weaker screens; cap its resolution.
    const isSpectator = faceEl.closest('.spectator-shell') !== null;
    const dpr = isSpectator ? Math.min(window.devicePixelRatio || 1, 1.5) : (window.devicePixelRatio || 1);
    const pw = Math.round(rect.width * dpr);
    const ph = Math.round(rect.height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    configureWebGpuCanvas(gpu, canvas);
    containerCssW = rect.width;
    containerCssH = rect.height;
    cachedDpr = dpr;
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

  /** Rebuilds the grid at once: first draw, resize, FX editor edits. */
  function buildGrid(): void {
    if (!faceEl) return;
    const next = buildNextGrid(faceEl);
    morphing = false;
    pixelGrid = next.pixelGrid;
    shapeCenters = next.shapeCenters;
    copyCenters(shapeCenters, drawnCenters);
    gridDirty = false;
    uploadPixels(pixelGrid);
  }

  /** The expression changed: pixels flow from what is on screen now (even mid-morph) to the new shape. */
  function morphGrid(now: number, previousKey: string, nextKey: string): void {
    if (!faceEl) return;
    const from = morphing ? snapshotMorph(morph, now - morphStart) : pixelGrid;
    copyCenters(drawnCenters, morphFromCenters);
    const next = buildNextGrid(faceEl);
    const timing = nextKey === 'sleep' ? MORPH_SLEEP : previousKey === 'sleep' ? MORPH_WAKE : MORPH;
    planMorph(from, next.pixelGrid, timing, morph, effectivePixelSize + effectivePixelGap);
    morphing = true;
    morphStart = now;
    pixelGrid = next.pixelGrid;
    shapeCenters = next.shapeCenters;
    ensureInstanceData(morph.count);
  }

  /** Uploads this frame of the morph; per-frame uploads stop once it lands. */
  function stepMorph(now: number): void {
    const elapsed = now - morphStart;
    if (elapsed >= morph.durationMs) {
      morphing = false;
      copyCenters(shapeCenters, drawnCenters);
      uploadPixels(pixelGrid);
      return;
    }
    const count = writeMorphFrame(morph, elapsed, instanceData);
    writeGpuInstances(gpu, instanceData, count);
    const p = easeOutCubic(elapsed / morph.durationMs);
    for (let i = 0; i < drawnCenters.length; i += 1) {
      const drawn = drawnCenters[i];
      const from = morphFromCenters[i];
      const to = shapeCenters[i];
      if (!drawn || !from || !to) continue;
      drawn.cx = from.cx + (to.cx - from.cx) * p;
      drawn.cy = from.cy + (to.cy - from.cy) * p;
    }
  }

  function buildNextGrid(face: HTMLElement): ReturnType<typeof buildPixelGrid> {
    const rect = face.getBoundingClientRect();
    const state = store.getState();
    const key = faceKey(state);
    builtFaceKey = key;
    builtProfileSignature = profileSignature(key);
    return buildPixelGrid(state, rendererConfig, rect.width, rect.height, effectivePixelSize, effectivePixelGap);
  }

  function uploadPixels(pixels: PixelGridPoint[]): void {
    ensureInstanceData(pixels.length);
    writeGpuInstances(gpu, instanceData, packPixels(pixels, instanceData));
  }

  function ensureInstanceData(count: number): void {
    if (instanceData.length < count * INSTANCE_FLOATS) {
      instanceData = new Float32Array(Math.ceil(count * 1.5) * INSTANCE_FLOATS);
    }
  }

  /** WebGPU only. If it can't start the face stays blank, so the event log says why. */
  function ensureRendererReady(): Promise<boolean> {
    if (rendererState.ready) return Promise.resolve(true);
    if (!rendererState.initPromise) {
      rendererState.initPromise = initWebGpuRenderer(gpu, canvas)
        .catch(() => false)
        .then((ok) => {
          rendererState.ready = ok;
          if (ok) {
            sizeCanvas();
            buildGrid();
          } else {
            store.appendLog('error', 'WebGPU did not start, so the face cannot render. Use a browser with WebGPU.');
          }
          return ok;
        });
    }
    return rendererState.initPromise;
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

    if (gridDirty) {
      buildGrid();
    } else {
      const key = faceKey(state);
      if (key !== builtFaceKey) {
        if (profileSignature(key) === builtProfileSignature) {
          // Same shape under another name (idle and speaking): nothing to redraw.
          builtFaceKey = key;
        } else {
          morphGrid(now, builtFaceKey, key);
        }
      }
    }
    if (morphing) {
      stepMorph(now);
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
      // The face behaviour runtime's gaze model is the only smoothing; easing
      // it again here made saccades drag.
      gazeX: state.gazeX,
      gazeY: state.gazeY,
      faceW: faceEl.getBoundingClientRect().width,
      faceH: faceEl.getBoundingClientRect().height,
      getBlinkFactor,
      getSpeakMouthScale,
      lastBurstState,
      glitchBurstSeed,
    });
    lastBurstState = frameResult.lastBurstState;
    glitchBurstSeed = frameResult.glitchBurstSeed;

    renderFrameWebGpu(frameResult.frame, {
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
      shapeCenters: drawnCenters,
      baseHSL: moodHSL,
      glitchBurstSeed,
      sleeping: state.sleeping,
    });
    setCanvasVisible(true);
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

/** The expression the grid shows: asleep always draws the sleep face. */
function faceKey(state: AppState): ExpressionName {
  return state.sleeping ? 'sleep' : state.currentExpression;
}

function profileSignature(expression: ExpressionName): string {
  return JSON.stringify(EXPRESSION_PROFILES[expression] ?? null);
}

function copyCenters(from: readonly ShapeCenter[], to: ShapeCenter[]): void {
  for (let i = 0; i < to.length; i += 1) {
    const source = from[i];
    const target = to[i];
    if (!source || !target) continue;
    target.cx = source.cx;
    target.cy = source.cy;
  }
}
