import type { GlitchConfig } from './constants.js';

export function recreateCanvasElement(canvas: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!canvas) return null;

  const next = document.createElement('canvas');
  next.className = canvas.className;
  next.id = canvas.id;
  next.style.cssText = canvas.style.cssText;
  if (canvas.parentElement) {
    canvas.parentElement.replaceChild(next, canvas);
  }
  return next;
}

export function rebuildScanlinePattern(
  ctx: CanvasRenderingContext2D | null,
  config: GlitchConfig,
  cachedDpr: number,
): CanvasPattern | null {
  if (!ctx || !config.glitch.scanlines) return null;

  const spacing = Math.max(1, Math.round(config.glitch.scanlineSpacing * cachedDpr));
  const thickness = Math.max(1, Math.round(config.glitch.scanlineThickness * cachedDpr));
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = 4;
  patternCanvas.height = spacing;
  const patternCtx = patternCanvas.getContext('2d');
  if (!patternCtx) return null;

  patternCtx.fillStyle = '#000';
  patternCtx.fillRect(0, 0, 4, thickness);
  return ctx.createPattern(patternCanvas, 'repeat');
}

export function initCanvas2DRenderer(
  canvas: HTMLCanvasElement | null,
  config: GlitchConfig,
  cachedDpr: number,
): {
  ok: boolean;
  ctx: CanvasRenderingContext2D | null;
  tempCanvas: HTMLCanvasElement | null;
  tempCtx: CanvasRenderingContext2D | null;
  scanlinePattern: CanvasPattern | null;
} {
  if (!canvas) {
    return { ok: false, ctx: null, tempCanvas: null, tempCtx: null, scanlinePattern: null };
  }

  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true }) ?? canvas.getContext('2d');
  if (!ctx) {
    return { ok: false, ctx: null, tempCanvas: null, tempCtx: null, scanlinePattern: null };
  }

  ctx.imageSmoothingEnabled = false;
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (tempCtx) tempCtx.imageSmoothingEnabled = false;
  const scanlinePattern = rebuildScanlinePattern(ctx, config, cachedDpr);
  return { ok: true, ctx, tempCanvas, tempCtx, scanlinePattern };
}

export function sizeCanvasLayout(args: {
  containerEl: HTMLElement | null;
  canvas: HTMLCanvasElement | null;
  config: GlitchConfig;
  rendererKind: 'webgpu' | 'canvas2d';
  ctx: CanvasRenderingContext2D | null;
  tempCanvas: HTMLCanvasElement | null;
  tempCtx: CanvasRenderingContext2D | null;
  scanlinePattern: CanvasPattern | null;
  configureWebGpuCanvas: () => void;
}): {
  containerCssW: number;
  containerCssH: number;
  cachedDpr: number;
  cachedGlowFilter: string;
  tempCanvas: HTMLCanvasElement | null;
  tempCtx: CanvasRenderingContext2D | null;
  scanlinePattern: CanvasPattern | null;
} | null {
  const { containerEl, canvas, config, rendererKind, ctx, tempCanvas, tempCtx, scanlinePattern, configureWebGpuCanvas } = args;
  if (!containerEl || !canvas) return null;

  const rect = containerEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const isSpectator = containerEl.closest('.spectator-shell') !== null;
  const dpr = isSpectator ? Math.min(window.devicePixelRatio || 1, 1.5) : (window.devicePixelRatio || 1);
  const pw = Math.round(rect.width * dpr);
  const ph = Math.round(rect.height * dpr);
  const sizeChanged = canvas.width !== pw || canvas.height !== ph;

  if (sizeChanged) {
    canvas.width = pw;
    canvas.height = ph;
  }

  let nextTempCanvas = tempCanvas;
  let nextTempCtx = tempCtx;
  let nextScanlinePattern = scanlinePattern;

  if (rendererKind === 'canvas2d' && ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!nextTempCanvas) {
      nextTempCanvas = document.createElement('canvas');
      nextTempCtx = nextTempCanvas.getContext('2d');
      if (nextTempCtx) nextTempCtx.imageSmoothingEnabled = false;
    }
    if (nextTempCanvas) {
      nextTempCanvas.width = pw;
      nextTempCanvas.height = ph;
    }
    if (sizeChanged) {
      nextScanlinePattern = rebuildScanlinePattern(ctx, config, dpr);
    }
  }

  if (rendererKind === 'webgpu') {
    configureWebGpuCanvas();
  }

  return {
    containerCssW: rect.width,
    containerCssH: rect.height,
    cachedDpr: dpr,
    cachedGlowFilter: `blur(${Math.round(config.glow.pixelGlow * dpr)}px)`,
    tempCanvas: nextTempCanvas,
    tempCtx: nextTempCtx,
    scanlinePattern: nextScanlinePattern,
  };
}
