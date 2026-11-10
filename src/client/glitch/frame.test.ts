import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, GPU_UNIFORM_FLOATS } from './constants.js';
import { writeGpuUniforms, type FrameState } from './frame.js';

// The scanlines scroll over a waking face. Over a sleeping one, which holds
// still between twitches, their scroll was the one thing moving: dark rows
// stepping a pixel or two every frame, read as the face shuffling.

const frameAt = (t: number): FrameState => ({
  t, dpr: 1, W: 1024, H: 1024, sz: 10, faceOX: 0, faceOY: 0, eyeGazeX: 0, eyeGazeY: 0, mouthGazeX: 0, mouthGazeY: 0,
  blinkF: 0, mouthScale: 1, pulseMod: 1, scanY: 0, sbHalfW: 0, chrOffX: 0, chrOffY: 0, inBurst: false, flickerMod: 1,
});

/** The post pass's scanline scroll (its uniform 43) for a frame at `t` seconds. */
function scroll(t: number, sleeping: boolean): number {
  const post = new Float32Array(GPU_UNIFORM_FLOATS);
  const config = structuredClone(DEFAULT_CONFIG);
  config.glitch.scanlines = true;
  config.glitch.scanlineMove = true;
  writeGpuUniforms(frameAt(t), {
    gpuDevice: { queue: { writeBuffer: () => undefined } }, gpuUniformBuffer: {}, gpuPostUniformBuffer: {},
    gpuUniformData: new Float32Array(GPU_UNIFORM_FLOATS), gpuPostUniformData: post,
    config, faceW: 1024, faceH: 1024, shapeCenters: [], shapeTransforms: new Float32Array(12), propTransform: new Float32Array(8),
    baseHSL: { h: 270, s: 90, l: 60 }, glitchBurstSeed: 0, sleeping,
  });
  return post[43]!;
}

describe('scanlines', () => {
  it('scroll while awake and hold still while asleep', () => {
    const awake = [0.1, 0.13, 0.16].map((t) => scroll(t, false));
    expect(new Set(awake).size).toBe(3);
    const asleep = [0.1, 0.13, 0.16, 2.5].map((t) => scroll(t, true));
    expect(new Set(asleep).size).toBe(1);
  });
});
