import type { AppState } from '../state/app-state.js';
import { GAZE_EYE_RANGE_X, GAZE_EYE_RANGE_Y, GAZE_MOUTH_RANGE_X, GAZE_MOUTH_RANGE_Y, GLOW_ALPHA, GPU_UNIFORM_FLOATS, type GlitchConfig } from './constants.js';
import { clamp01 } from './utils.js';

export interface FrameState {
  t: number;
  dpr: number;
  pw: number;
  ph: number;
  W: number;
  H: number;
  sz: number;
  faceOX: number;
  faceOY: number;
  eyeGazeX: number;
  eyeGazeY: number;
  mouthGazeX: number;
  mouthGazeY: number;
  blinkF: number;
  mouthScale: number;
  pulseMod: number;
  scanY: number;
  sbHalfW: number;
  chrOffX: number;
  chrOffY: number;
  inBurst: boolean;
  flickerMod: number;
}

export function computeFrameState(
  now: number,
  args: {
    state: AppState;
    config: GlitchConfig;
    startTime: number;
    cachedDpr: number;
    canvas: HTMLCanvasElement;
    containerCssW: number;
    containerCssH: number;
    effectivePixelSize: number;
    currentGazeX: number;
    currentGazeY: number;
    faceW: number;
    faceH: number;
    getBlinkFactor: (time: number) => number;
    getSpeakMouthScale: (time: number) => number;
    lastBurstState: boolean;
    glitchBurstSeed: number;
  },
): { frame: FrameState; lastBurstState: boolean; glitchBurstSeed: number } {
  const { state, config, startTime, cachedDpr, canvas, containerCssW, containerCssH, effectivePixelSize, currentGazeX, currentGazeY, faceW, faceH, getBlinkFactor, getSpeakMouthScale, lastBurstState, glitchBurstSeed } = args;

  const t = (now - startTime) / 1000;
  const dpr = cachedDpr;
  const pw = canvas.width;
  const ph = canvas.height;
  const W = containerCssW || (pw / dpr);
  const H = containerCssH || (ph / dpr);
  const sz = effectivePixelSize;
  const faceOX = 0;
  const faceOY = 0;

  const eyeGazeX = currentGazeX * faceW * GAZE_EYE_RANGE_X;
  const eyeGazeY = currentGazeY * faceH * GAZE_EYE_RANGE_Y;
  const mouthGazeX = currentGazeX * faceW * GAZE_MOUTH_RANGE_X;
  const mouthGazeY = currentGazeY * faceH * GAZE_MOUTH_RANGE_Y;
  const blinkF = getBlinkFactor(now);
  const mouthScale = getSpeakMouthScale(now);

  const pulse = config.brightnessPulse;
  const pulseMod = pulse.enabled
    ? pulse.dim + (pulse.bright - pulse.dim) * Math.pow(0.5 + 0.5 * Math.sin(t * pulse.speed * 0.3), 6)
    : 1;

  const scanBeam = config.scanBeam;
  const scanY = scanBeam.enabled
    ? H * (0.5 + 0.5 * Math.sin(t * scanBeam.speed * 0.15)) + (Math.random() - 0.5) * scanBeam.jitter
    : -9999;
  const sbHalfW = scanBeam.lineWidth * sz * 0.5;

  const chroma = config.chromatic;
  const chrOffX = chroma.enabled
    ? chroma.offsetX + (chroma.animate ? Math.sin(t * chroma.animateSpeed * 0.4) * 2 : 0)
    : 0;
  const chrOffY = chroma.enabled
    ? chroma.offsetY + (chroma.animate ? Math.cos(t * chroma.animateSpeed * 0.3) * 2 : 0)
    : 0;

  const slice = config.glitchSlice;
  const burstPhase = (now - startTime) % (slice.interval + slice.burstDuration);
  const inBurst = slice.enabled && burstPhase > slice.interval;
  let nextGlitchBurstSeed = glitchBurstSeed;
  if (inBurst) {
    // Dynamically animate the burst seed throughout the duration of the glitch.
    // This feeds the WebGPU shader to recreate a rapidly fluctuating distortion animation 
    // rather than staying frozen on one offset seed.
    if (!lastBurstState || Math.random() > 0.15) {
      nextGlitchBurstSeed = Math.random() * 1000;
    }
  }

  const flicker = config.glitch;
  const flickerMod = flicker.flicker
    ? 1 - flicker.flickerDepth * (0.5 + 0.5 * Math.sin(t * flicker.flickerSpeed * 2))
    : 1;

  return {
    frame: {
      t, dpr, pw, ph, W, H, sz, faceOX, faceOY,
      eyeGazeX, eyeGazeY, mouthGazeX, mouthGazeY,
      blinkF, mouthScale, pulseMod, scanY, sbHalfW,
      chrOffX, chrOffY, inBurst, flickerMod,
    },
    lastBurstState: inBurst,
    glitchBurstSeed: nextGlitchBurstSeed,
  };
}

export function writeGpuUniforms(
  frame: FrameState,
  args: {
    gpuDevice: any;
    gpuUniformBuffer: any;
    gpuPostUniformBuffer: any;
    gpuUniformData: Float32Array;
    gpuPostUniformData: Float32Array;
    config: GlitchConfig;
    faceW: number;
    faceH: number;
    shapeCenters: Array<{ cy: number }>;
    baseHSL: { h: number; s: number; l: number };
    glitchBurstSeed: number;
    sleeping: boolean;
  },
): void {
  const { gpuDevice, gpuUniformBuffer, gpuPostUniformBuffer, gpuUniformData, gpuPostUniformData, config, faceW, faceH, shapeCenters, baseHSL, glitchBurstSeed, sleeping } = args;
  if (!gpuDevice || !gpuUniformBuffer || !gpuPostUniformBuffer) return;

  const sb = config.scanBeam;
  const chr = config.chromatic;
  const gs = config.glitchSlice;
  const fl = config.glitch;
  const spacing = Math.max(1, fl.scanlineSpacing);
  const scanlineScroll = fl.scanlineMove ? (frame.t * fl.scanlineSpeed) % spacing : 0;
  const scanlineThicknessRatio = Math.min(0.95, Math.max(0.02, fl.scanlineThickness / spacing));
  const bloomIntensity = Math.max(0, config.glow.bloomIntensity);
  const glowStrength = Math.max(0, config.glow.pixelGlow / 24);

  gpuUniformData.fill(0);
  gpuPostUniformData.fill(0);
  const uniforms = [gpuUniformData, gpuPostUniformData];
  for (const u of uniforms) {
    u[0] = frame.W; u[1] = frame.H; u[2] = frame.dpr; u[3] = frame.t;
    u[4] = frame.faceOX; u[5] = frame.faceOY; u[6] = faceW; u[7] = faceH;
    u[8] = frame.eyeGazeX; u[9] = frame.eyeGazeY; u[10] = frame.mouthGazeX; u[11] = frame.mouthGazeY;
    u[12] = shapeCenters[0]?.cy || 0; u[13] = shapeCenters[1]?.cy || 0; u[14] = shapeCenters[2]?.cy || 0; u[15] = frame.blinkF;
    u[16] = frame.mouthScale; u[17] = frame.sz; u[18] = config.color.opacityMin; u[19] = frame.pulseMod;
    u[20] = (((baseHSL.h % 360) + 360) % 360) / 360; u[21] = clamp01(baseHSL.s / 100); u[22] = clamp01(baseHSL.l / 100); u[23] = frame.flickerMod;
    u[24] = frame.scanY; u[25] = frame.sbHalfW; u[26] = sb.brightness; u[27] = sb.glowStrength;
    u[28] = frame.chrOffX; u[29] = frame.chrOffY; u[30] = chr.intensity; u[31] = chr.enabled ? 1 : 0;
    u[32] = frame.inBurst ? 1 : 0; u[33] = gs.sliceCount; u[34] = gs.maxOffset; u[35] = gs.intensity;
    u[36] = gs.gapChance; u[37] = glitchBurstSeed; u[38] = gs.interval / 1000; u[39] = gs.burstDuration / 1000;
    u[40] = fl.scanlines ? 1 : 0; u[41] = fl.scanlineIntensity; u[42] = spacing; u[43] = scanlineScroll;
    u[44] = sleeping ? 1 : 0; u[45] = scanlineThicknessRatio; u[46] = bloomIntensity; u[47] = glowStrength;
  }

  gpuUniformData[23] = 1;
  gpuUniformData[31] = 0;
  gpuUniformData[32] = 0;
  gpuUniformData[40] = 0;

  gpuDevice.queue.writeBuffer(gpuUniformBuffer, 0, gpuUniformData.buffer, gpuUniformData.byteOffset, GPU_UNIFORM_FLOATS * 4);
  gpuDevice.queue.writeBuffer(gpuPostUniformBuffer, 0, gpuPostUniformData.buffer, gpuPostUniformData.byteOffset, GPU_UNIFORM_FLOATS * 4);
}

export function renderFrameWebGpu(frame: FrameState, args: {
  gpuDevice: any;
  gpuContext: any;
  gpuPixelPipeline: any;
  gpuPostPipeline: any;
  gpuPixelBindGroup: any;
  gpuPostBindGroup: any;
  gpuSceneTextureView: any;
  gpuInstanceCount: number;
  gpuUniformBuffer: any;
  gpuPostUniformBuffer: any;
  gpuUniformData: Float32Array;
  gpuPostUniformData: Float32Array;
  config: GlitchConfig;
  faceW: number;
  faceH: number;
  shapeCenters: Array<{ cy: number }>;
  baseHSL: { h: number; s: number; l: number };
  glitchBurstSeed: number;
  sleeping: boolean;
}): boolean {
  const { gpuDevice, gpuContext, gpuPixelPipeline, gpuPostPipeline, gpuPixelBindGroup, gpuPostBindGroup, gpuSceneTextureView, gpuInstanceCount } = args;
  if (!gpuDevice || !gpuContext || !gpuPixelPipeline || !gpuPostPipeline || !gpuPixelBindGroup || !gpuPostBindGroup || !gpuSceneTextureView || gpuInstanceCount <= 0) return false;
  writeGpuUniforms(frame, args);

  let texture;
  try {
    texture = gpuContext.getCurrentTexture();
  } catch (error) {
    console.warn('[GlitchFX] WebGPU frame acquire failed:', error);
    return false;
  }

  try {
    const encoder = gpuDevice.createCommandEncoder();
    const scenePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: gpuSceneTextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    scenePass.setPipeline(gpuPixelPipeline);
    scenePass.setBindGroup(0, gpuPixelBindGroup);
    scenePass.draw(6, gpuInstanceCount, 0, 0);
    scenePass.end();

    const swapPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    swapPass.setPipeline(gpuPostPipeline);
    swapPass.setBindGroup(0, gpuPostBindGroup);
    swapPass.draw(6, 1, 0, 0);
    swapPass.end();

    gpuDevice.queue.submit([encoder.finish()]);
    return true;
  } catch (error) {
    console.warn('[GlitchFX] WebGPU frame render failed:', error);
    return false;
  }
}

export function renderFrameCanvas2D(frame: FrameState, args: {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  tempCtx: CanvasRenderingContext2D | null;
  tempCanvas: HTMLCanvasElement | null;
  config: GlitchConfig;
  baseHSL: { h: number; s: number; l: number };
  pixelGrid: Array<{ x: number; y: number; brightOff: number; lut: string[] }>;
  shapeGroups: number[];
  shapeCenters: Array<{ cy: number }>;
  cachedGlowFilter: string;
  cachedScanBeamRGBA: string;
  scanlinePattern: CanvasPattern | null;
}): boolean {
  const { canvas, ctx, tempCtx, tempCanvas, config, baseHSL, pixelGrid, shapeGroups, shapeCenters, cachedGlowFilter, cachedScanBeamRGBA, scanlinePattern } = args;
  if (!ctx || !tempCtx || !tempCanvas) return false;
  const { t, dpr, pw, ph, W, H, sz, faceOX, faceOY, eyeGazeX, eyeGazeY, mouthGazeX, mouthGazeY, blinkF, mouthScale, pulseMod, scanY, sbHalfW, chrOffX, chrOffY, inBurst, flickerMod } = frame;
  const sb = config.scanBeam;
  const chr = config.chromatic;
  const gs = config.glitchSlice;
  const fl = config.glitch;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const baseLight = baseHSL.l;
  for (const [i, point] of pixelGrid.entries()) {
    const group = shapeGroups[i] ?? 0;
    let drawX = point.x + faceOX;
    let drawY = point.y + faceOY;
    let drawSzY = sz;

    if (group <= 1) {
      drawX += eyeGazeX;
      drawY += eyeGazeY;
      if (blinkF > 0 && shapeCenters[group]) {
        const centerY = (shapeCenters[group]?.cy ?? 0) + faceOY + eyeGazeY;
        drawY = centerY + (drawY - centerY) * (1 - blinkF);
        drawSzY = Math.max(2, sz * (1 - blinkF * 0.85));
      }
    }

    if (group === 2) {
      drawX += mouthGazeX;
      drawY += mouthGazeY;
      if (mouthScale !== 1 && shapeCenters[2]) {
        const centerY = shapeCenters[2].cy + faceOY + mouthGazeY;
        drawY = centerY + (drawY - centerY) * mouthScale;
      }
    }

    if (group >= 3) {
      drawX += eyeGazeX;
      drawY += eyeGazeY;
      drawY += Math.sin(t * 1.5 + point.y * 0.05) * sz * 0.3;
    }

    let light = (baseLight + point.brightOff) * pulseMod;
    if (sb.enabled) {
      const dist = Math.abs(drawY + sz * 0.5 - scanY);
      if (dist < sbHalfW) {
        light += (1 - dist / sbHalfW) * sb.brightness * 30;
      }
    }

    const li = light < 0 ? 0 : light > 100 ? 100 : (light + 0.5) | 0;
    if (group >= 3) {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 2 + (group - 3) * Math.PI);
    }
        ctx.fillStyle = point.lut[li] ?? point.lut[0] ?? '#ffffff';
    ctx.fillRect(drawX, drawY, sz, drawSzY);
    if (group >= 3) {
      ctx.globalAlpha = 1;
    }
  }

  tempCtx.setTransform(1, 0, 0, 1, 0, 0);
  tempCtx.clearRect(0, 0, pw, ph);
  tempCtx.drawImage(canvas, 0, 0);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.filter = cachedGlowFilter;
  ctx.globalAlpha = GLOW_ALPHA * config.glow.bloomIntensity * flickerMod;
  ctx.drawImage(tempCanvas, 0, 0);

  ctx.filter = 'none';
  ctx.globalAlpha = flickerMod;
  ctx.drawImage(tempCanvas, 0, 0);

  if (chr.enabled && chr.intensity > 0) {
    ctx.filter = 'hue-rotate(40deg)';
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = chr.intensity * 0.35 * flickerMod;
    ctx.drawImage(tempCanvas, Math.round(chrOffX * dpr), Math.round(chrOffY * dpr));
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
  }

  if (inBurst) {
    tempCtx.clearRect(0, 0, pw, ph);
    tempCtx.drawImage(canvas, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const sliceH = Math.ceil(ph / gs.sliceCount);
    for (let j = 0; j < gs.sliceCount; j += 1) {
      if (Math.random() < gs.gapChance) continue;
      const sy = j * sliceH;
      const off = ((Math.random() - 0.5) * 2 * gs.maxOffset * gs.intensity * dpr) | 0;
      ctx.drawImage(tempCanvas, 0, sy, pw, sliceH, off, sy, pw, sliceH);
    }
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (sb.enabled) {
    const beamHalf = sb.lineWidth * sz;
    const grad = ctx.createLinearGradient(0, scanY - beamHalf, 0, scanY + beamHalf);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.5, cachedScanBeamRGBA);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.globalAlpha = sb.glowStrength / 100;
    ctx.fillRect(0, scanY - beamHalf, W, beamHalf * 2);
  }

  if (fl.scanlines && scanlinePattern) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = fl.scanlineIntensity;
    ctx.fillStyle = scanlinePattern;
    const sp = Math.max(1, Math.round(fl.scanlineSpacing * dpr));
    const scrollOff = fl.scanlineMove ? Math.round(t * fl.scanlineSpeed * dpr) % sp : 0;
    ctx.save();
    ctx.translate(0, scrollOff);
    ctx.fillRect(0, -scrollOff, pw, ph + sp);
    ctx.restore();
  }

  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}
