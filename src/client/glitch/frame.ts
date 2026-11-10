import type { AppState } from '../state/app-state.js';
import { GAZE_EYE_RANGE_X, GAZE_EYE_RANGE_Y, GAZE_MOUTH_RANGE_X, GAZE_MOUTH_RANGE_Y, GLOW_ALPHA, GPU_UNIFORM_FLOATS, type GlitchConfig } from './constants.js';
import { clamp01 } from './utils.js';
import type { GpuHandle } from './webgpu.js';

/** Where the per-shape transforms start in the pixel pass uniforms (after the 12 shared vec4s). */
const SHAPE_TRANSFORM_OFFSET = 48;
/** And a worn prop's, after the eyes' and mouth's. */
const PROP_TRANSFORM_OFFSET = 60;

export interface FrameState {
  t: number;
  dpr: number;
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
    gazeX: number;
    gazeY: number;
    faceW: number;
    faceH: number;
    getBlinkFactor: (time: number) => number;
    getSpeakMouthScale: (time: number) => number;
    lastBurstState: boolean;
    glitchBurstSeed: number;
    /** Mood: more frequent bursts and a wider colour split when Tubs is worked up. */
    tint?: { burstInterval: number; chroma: number };
  },
): { frame: FrameState; lastBurstState: boolean; glitchBurstSeed: number } {
  const { config, startTime, cachedDpr, canvas, containerCssW, containerCssH, effectivePixelSize, gazeX, gazeY, faceW, faceH, getBlinkFactor, getSpeakMouthScale, lastBurstState, glitchBurstSeed } = args;
  const chromaScale = args.tint?.chroma ?? 1;

  const t = (now - startTime) / 1000;
  const dpr = cachedDpr;
  const pw = canvas.width;
  const ph = canvas.height;
  const W = containerCssW || (pw / dpr);
  const H = containerCssH || (ph / dpr);
  const sz = effectivePixelSize;
  const faceOX = 0;
  const faceOY = 0;

  const eyeGazeX = gazeX * faceW * GAZE_EYE_RANGE_X;
  const eyeGazeY = gazeY * faceH * GAZE_EYE_RANGE_Y;
  const mouthGazeX = gazeX * faceW * GAZE_MOUTH_RANGE_X;
  const mouthGazeY = gazeY * faceH * GAZE_MOUTH_RANGE_Y;
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
    ? (chroma.offsetX + (chroma.animate ? Math.sin(t * chroma.animateSpeed * 0.4) * 2 : 0)) * chromaScale
    : 0;
  const chrOffY = chroma.enabled
    ? (chroma.offsetY + (chroma.animate ? Math.cos(t * chroma.animateSpeed * 0.3) * 2 : 0)) * chromaScale
    : 0;

  const slice = config.glitchSlice;
  const burstInterval = slice.interval * (args.tint?.burstInterval ?? 1);
  const burstPhase = (now - startTime) % (burstInterval + slice.burstDuration);
  const inBurst = slice.enabled && burstPhase > burstInterval;
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
      t, dpr, W, H, sz, faceOX, faceOY,
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
    gpuDevice: GpuHandle;
    gpuUniformBuffer: GpuHandle;
    gpuPostUniformBuffer: GpuHandle;
    gpuUniformData: Float32Array;
    gpuPostUniformData: Float32Array;
    config: GlitchConfig;
    faceW: number;
    faceH: number;
    shapeCenters: Array<{ cy: number }>;
    /** Left eye, right eye, mouth: (sx, sy, tx, ty) each, from the living expression motion. */
    shapeTransforms: Float32Array;
    /** A worn prop's pivot, tilt and offset (props.ts packPropTransform). */
    propTransform: Float32Array;
    baseHSL: { h: number; s: number; l: number };
    glitchBurstSeed: number;
    sleeping: boolean;
  },
): void {
  const { gpuDevice, gpuUniformBuffer, gpuPostUniformBuffer, gpuUniformData, gpuPostUniformData, config, faceW, faceH, shapeCenters, shapeTransforms, propTransform, baseHSL, glitchBurstSeed, sleeping } = args;
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
  // Pixel pass only (xformL, xformR, xformM, prop); the post pass doesn't move shapes.
  gpuUniformData.set(shapeTransforms, SHAPE_TRANSFORM_OFFSET);
  gpuUniformData.set(propTransform, PROP_TRANSFORM_OFFSET);

  gpuDevice.queue.writeBuffer(gpuUniformBuffer, 0, gpuUniformData.buffer, gpuUniformData.byteOffset, GPU_UNIFORM_FLOATS * 4);
  gpuDevice.queue.writeBuffer(gpuPostUniformBuffer, 0, gpuPostUniformData.buffer, gpuPostUniformData.byteOffset, GPU_UNIFORM_FLOATS * 4);
}

export function renderFrameWebGpu(frame: FrameState, args: {
  gpuDevice: GpuHandle;
  gpuContext: GpuHandle;
  gpuPixelPipeline: GpuHandle;
  gpuPostPipeline: GpuHandle;
  gpuPixelBindGroup: GpuHandle;
  gpuPostBindGroup: GpuHandle;
  gpuSceneTextureView: GpuHandle;
  gpuInstanceCount: number;
  gpuUniformBuffer: GpuHandle;
  gpuPostUniformBuffer: GpuHandle;
  gpuUniformData: Float32Array;
  gpuPostUniformData: Float32Array;
  config: GlitchConfig;
  faceW: number;
  faceH: number;
  shapeCenters: Array<{ cy: number }>;
  shapeTransforms: Float32Array;
  propTransform: Float32Array;
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
