import { describe, expect, it } from 'vitest';
import {
  GAZE_DEAD_ZONE,
  GAZE_MIN_FIXATION_MS,
  SACCADE_MAX_MS,
  createGazeController,
  nearestFaceIndex,
  type GazeSample,
} from './gaze.js';

// Tubs's eyes should read like real eyes: hold still on what they look at,
// jump to the next thing quickly, and not shiver with every wobble of the
// camera's face box. Spring-following the raw box made him look nervous.

const FRAME_MS = 1000 / 60;

/** Deterministic noise in -1..1, so a failure is reproducible. */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

function run(
  controller: ReturnType<typeof createGazeController>,
  fromMs: number,
  durationMs: number,
  feed: (nowMs: number) => void,
): Array<{ t: number; x: number; y: number }> {
  const out: GazeSample = { x: 0, y: 0, moving: false };
  const samples: Array<{ t: number; x: number; y: number }> = [];
  for (let t = fromMs; t < fromMs + durationMs; t += FRAME_MS) {
    feed(t);
    controller.sample(t, out);
    samples.push({ t, x: out.x, y: out.y });
  }
  return samples;
}

/** A controller already resting on (x, y). */
function settledOn(x: number, y: number) {
  const controller = createGazeController();
  run(controller, 0, 600, (t) => controller.track(x, y, t));
  return controller;
}

describe('gaze', () => {
  it('holds perfectly still while the face box only jitters', () => {
    const controller = settledOn(0.3, 0.1);
    const rand = noise(7);
    // Detector noise of up to 70% of the dead zone, every frame, for 3 s.
    const jitter = GAZE_DEAD_ZONE * 0.7;
    const samples = run(controller, 600, 3000, (t) => controller.track(0.3 + rand() * jitter, 0.1 + rand() * jitter, t));
    const xs = new Set(samples.map((sample) => sample.x));
    const ys = new Set(samples.map((sample) => sample.y));
    expect(xs.size).toBe(1);
    expect(ys.size).toBe(1);
    expect(samples[0]!.x).toBeCloseTo(0.3, 1);
  });

  it('follows a real move of the person, landing near them within a second', () => {
    const controller = settledOn(0.3, 0.1);
    const rand = noise(11);
    const samples = run(controller, 600, 1000, (t) => controller.track(0.65 + rand() * 0.02, 0.1, t));
    const last = samples.at(-1)!;
    expect(Math.abs(last.x - 0.65)).toBeLessThan(GAZE_DEAD_ZONE);
  });

  it('holds each fixation: saccades start at least the fixation window apart', () => {
    const controller = settledOn(-0.8, 0);
    // Someone walking steadily across the room: the eyes catch up in jumps.
    const samples = run(controller, 600, 2400, (t) => controller.track(-0.8 + ((t - 600) / 2400) * 1.6, 0, t));
    const onsets: number[] = [];
    for (let i = 1; i < samples.length; i += 1) {
      const moved = samples[i]!.x !== samples[i - 1]!.x;
      const wasStill = i < 2 || samples[i - 1]!.x === samples[i - 2]!.x;
      if (moved && wasStill) onsets.push(samples[i - 1]!.t);
    }
    expect(onsets.length).toBeGreaterThan(2);
    for (let i = 1; i < onsets.length; i += 1) {
      expect(onsets[i]! - onsets[i - 1]!).toBeGreaterThanOrEqual(GAZE_MIN_FIXATION_MS - FRAME_MS);
    }
  });

  it('jumps quickly and decelerates into the new point', () => {
    const controller = settledOn(0, 0);
    controller.lookAt(0.6, 0, 600);
    const samples = run(controller, 600, 400, () => {});
    const arrived = samples.find((sample) => sample.x === 0.6);
    expect(arrived).toBeDefined();
    expect(arrived!.t - 600).toBeLessThanOrEqual(SACCADE_MAX_MS + FRAME_MS);
    // Ease-out: well over half the way after the first third of the jump.
    const third = samples.find((sample) => sample.t >= 600 + (arrived!.t - 600) / 3)!;
    expect(third.x).toBeGreaterThan(0.3);
  });

  it('takes deliberate looks exactly, even small ones the dead zone would swallow', () => {
    const controller = settledOn(0, 0);
    controller.lookAt(0.03, -0.02, 600);
    const last = run(controller, 600, 400, () => {}).at(-1)!;
    expect(last.x).toBeCloseTo(0.03, 5);
    expect(last.y).toBeCloseTo(-0.02, 5);
  });

  it('a look that arrives mid-fixation waits for it to end instead of cutting it short', () => {
    const controller = settledOn(0, 0);
    controller.lookAt(0.5, 0, 600);
    run(controller, 600, 100, () => {});
    controller.lookAt(-0.5, 0, 700);
    const samples = run(controller, 700, 500, () => {});
    const landed = samples.findIndex((sample) => sample.x === 0.5);
    expect(landed).toBeGreaterThanOrEqual(0);
    const turnedBack = samples.slice(landed).find((sample) => sample.x < 0.5);
    expect(turnedBack!.t - 600).toBeGreaterThanOrEqual(GAZE_MIN_FIXATION_MS - FRAME_MS);
    expect(samples.at(-1)!.x).toBeCloseTo(-0.5, 5);
  });

  it('micro-saccades are tiny jumps around the fixation, not a drift away from it', () => {
    const controller = settledOn(0.2, 0);
    controller.microSaccade(0.015, -0.01, 600);
    const last = run(controller, 600, 200, (t) => controller.track(0.2, 0, t)).at(-1)!;
    expect(last.x).toBeCloseTo(0.215, 5);
    expect(last.y).toBeCloseTo(-0.01, 5);
  });

  it('reports settled once the eyes rest, so the animation loop can stop', () => {
    const controller = settledOn(0.1, 0.1);
    const out: GazeSample = { x: 0, y: 0, moving: true };
    controller.sample(700, out);
    expect(out.moving).toBe(false);
    controller.lookAt(-0.4, 0, 710);
    controller.sample(720, out);
    expect(out.moving).toBe(true);
  });
});

describe('nearestFaceIndex', () => {
  it('stays with the same person when the detector lists faces in another order', () => {
    const anna = { box: [100, 100, 200, 200] as [number, number, number, number] };
    const ben = { box: [500, 120, 600, 220] as [number, number, number, number] };
    // Looking at Ben (centre 550, 170); he moved a little and the order flipped.
    const movedBen = { box: [510, 125, 610, 225] as [number, number, number, number] };
    expect(nearestFaceIndex([anna, ben], 550, 170)).toBe(1);
    expect(nearestFaceIndex([movedBen, anna], 550, 170)).toBe(0);
  });
});
