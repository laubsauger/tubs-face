import { describe, expect, it } from 'vitest';
import {
  GAZE_DEAD_ZONE,
  GAZE_MIN_FIXATION_MS,
  GAZE_PURSUIT_MS,
  SACCADE_MAX_MS,
  createGazeController,
  criticallyDamped,
  nearestFaceIndex,
  type GazeSample,
} from './gaze.js';

// Tubs's eyes should read like real eyes: hold still on what they look at,
// jump to the next thing quickly, and not shiver with every wobble of the
// camera's face box. Spring-following the raw box made him look nervous.

const FRAME_MS = 1000 / 60;
const sampleOut = (): GazeSample => ({ x: 0, y: 0, moving: false });

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

// In the studio the director moves the heads past the windows and sends where
// to look up to 10 times a second. Fixations and saccades on that read as the
// face jumping around; the eyes follow it smoothly instead, and whatever else
// moves them (a thinking glance, a micro-saccade) blends in without a jump.
describe('following the director\'s look', () => {
  const FRAME = 1000 / 60;
  const steps = (path: number[]) => path.slice(1).map((value, i) => Math.abs(value - path[i]!));

  it('eases to a new look in 120-200 ms, without overshoot or a jump', () => {
    const gaze = createGazeController();
    const out = sampleOut();
    gaze.sample(0, out);
    gaze.pursue(0.5, 0, 0);
    const path: number[] = [];
    let reached = Number.NaN;
    for (let t = 0; t <= 600; t += FRAME) {
      gaze.sample(t, out);
      path.push(out.x);
      if (Number.isNaN(reached) && out.x >= 0.475) reached = t;
    }
    expect(GAZE_PURSUIT_MS).toBeGreaterThanOrEqual(120);
    expect(reached).toBeGreaterThanOrEqual(120);
    expect(reached).toBeLessThanOrEqual(200);
    expect(Math.max(...path)).toBeLessThanOrEqual(0.5 + 1e-9);
    // The largest step of one frame is a fraction of the move, never the move.
    expect(Math.max(...steps(path))).toBeLessThan(0.5 * 0.2);
  });

  it('turns a 10 Hz stream of looks along a sweep into a continuous path, where saccades would jump', () => {
    const follow = (useTrack: boolean) => {
      const gaze = createGazeController();
      const out = sampleOut();
      const path: number[] = [];
      // Resting on the start of the sweep first, then a new look every 100 ms.
      for (let t = 0; t <= 3000; t += FRAME) {
        const update = Math.max(0, Math.floor((t - 600) / 100) * 100);
        const target = -0.6 + Math.min(1.2, (update / 2000) * 1.2);
        if (useTrack) gaze.track(target, 0, t);
        else gaze.pursue(target, 0, t);
        gaze.sample(t, out);
        if (t >= 600) path.push(out.x);
      }
      return { path, maxStep: Math.max(...steps(path)) };
    };
    const smooth = follow(false);
    // 0.6 a second is 0.01 a frame: the eyes never move much more than that.
    expect(smooth.maxStep).toBeLessThan(0.02);
    expect(smooth.path.at(-1)).toBeCloseTo(0.6, 2);
    // What tracking did with the same looks: fixations, then jumps.
    expect(follow(true).maxStep).toBeGreaterThan(smooth.maxStep * 2);
  });

  it('hands over to a deliberate look (the thinking glance) from where the eyes are', () => {
    const gaze = createGazeController();
    const out = sampleOut();
    gaze.sample(0, out);
    gaze.pursue(0.4, 0.1, 0);
    let t = 0;
    for (; t <= 70; t += FRAME) gaze.sample(t, out);
    const before = { x: out.x, y: out.y };
    gaze.lookAt(-0.5, -0.4, t);
    gaze.sample(t, out);
    expect(Math.hypot(out.x - before.x, out.y - before.y)).toBeLessThan(0.02);
    for (const end = t + 600; t < end; t += FRAME) gaze.sample(t, out);
    expect(out.x).toBeCloseTo(-0.5, 3);
  });

  it('lets micro-saccades ride on top, tiny and eased', () => {
    const gaze = createGazeController();
    const out = sampleOut();
    gaze.pursue(0.2, 0, 0);
    let t = 0;
    for (; t <= 800; t += FRAME) gaze.sample(t, out);
    const resting = out.x;
    gaze.microSaccade(0.018, 0, t);
    const path = [resting];
    for (let i = 0; i < 12; i += 1) {
      t += FRAME;
      gaze.sample(t, out);
      path.push(out.x);
    }
    expect(Math.max(...steps(path))).toBeLessThanOrEqual(0.018);
    expect(path.at(-1)! - resting).toBeCloseTo(0.018, 3);
  });

  it('holds a fixation once the look is steady: a swaying target does not drag the eyes along', () => {
    const gaze = createGazeController();
    const out = sampleOut();
    gaze.sample(0, out);
    let t = 0;
    for (; t <= 800; t += FRAME) {
      gaze.pursue(0.3, 0, t);
      gaze.sample(t, out);
    }
    const fixed = out.x;
    const path: number[] = [];
    for (let i = 0; i < 60; i += 1, t += FRAME) {
      gaze.pursue(0.3 + (i % 2 ? 0.01 : -0.01), 0, t);
      gaze.sample(t, out);
      path.push(out.x);
    }
    expect(Math.max(...path.map((x) => Math.abs(x - fixed)))).toBeLessThan(1e-9);
  });

  it('solves the spring exactly, so a long frame cannot make it overshoot', () => {
    const [x, v] = criticallyDamped(0, 0, 1, 1000);
    expect(x).toBeLessThanOrEqual(1);
    expect(x).toBeGreaterThan(0.999);
    expect(Math.abs(v)).toBeLessThan(1e-6);
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
