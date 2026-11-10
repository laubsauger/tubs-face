import { describe, expect, it } from 'vitest';
import type { ExpressionName } from '../../shared/contracts/config.js';
import { EXPRESSIONS } from '../../shared/contracts/config.js';
import { MOTION } from './constants.js';
import { createExpressionMotion, createFaceMotion, packShapeTransforms, type FaceMotion } from './expression-motion.js';

// A held expression should feel alive (breathing, a pop when surprised, a hop
// when happy, a sinking sadness) without ever turning into a cartoon, and the
// head should turn with the gaze. These pin down what each motion is for.

const FRAME_MS = 1000 / 60;

interface Sample { t: number; m: FaceMotion }

/** Runs the motion for durationMs, holding `expression`, and records every frame. */
function play(
  motion: ReturnType<typeof createExpressionMotion>,
  expression: ExpressionName | null,
  fromMs: number,
  durationMs: number,
  gazeX = 0,
): Sample[] {
  const samples: Sample[] = [];
  for (let t = fromMs; t < fromMs + durationMs; t += FRAME_MS) {
    samples.push({ t, m: structuredClone(motion.update(expression, t, gazeX, createFaceMotion())) });
  }
  return samples;
}

/** A motion that has been showing `expression` for a while. */
function settledIn(expression: ExpressionName) {
  const motion = createExpressionMotion();
  play(motion, expression, 0, 5000);
  return motion;
}

const range = (values: number[]) => Math.max(...values) - Math.min(...values);

describe('living expressions', () => {
  it('idle breathes: a slow, small swell rather than a still picture', () => {
    const samples = play(settledIn('idle'), 'idle', 5000, 8400);
    const sy = samples.map((s) => s.m.left.sy);
    expect(range(sy)).toBeGreaterThan(MOTION.breathScale);
    expect(range(sy)).toBeLessThanOrEqual(2 * MOTION.breathScale + 1e-6);
    // About two breaths in 8.4 s: slow, not a flutter.
    let crossings = 0;
    for (let i = 1; i < sy.length; i += 1) if ((sy[i - 1]! - 1) * (sy[i]! - 1) < 0) crossings += 1;
    expect(crossings).toBeGreaterThanOrEqual(3);
    expect(crossings).toBeLessThanOrEqual(5);
  });

  // A pixel grid that is scaled or moved by a fraction of a screen pixel is
  // re-rasterised with some quad edges a pixel further on, different ones each
  // frame: asleep that read as a face shuffling by a pixel, all the time.
  it('asleep the shapes hold their size and place (breathing is in the brightness, face/sleep-life.ts)', () => {
    const samples = play(settledIn('sleep'), 'sleep', 5000, 8000);
    for (const key of ['left', 'right', 'mouth'] as const) {
      expect(range(samples.map((s) => s.m[key].sx))).toBeLessThan(1e-9);
      expect(range(samples.map((s) => s.m[key].sy))).toBeLessThan(1e-9);
      expect(range(samples.map((s) => s.m[key].ox))).toBeLessThan(1e-9);
      expect(range(samples.map((s) => s.m[key].oy))).toBeLessThan(1e-9);
    }
  });

  it('surprised pops in: swells past its size right away, then settles', () => {
    const motion = settledIn('idle');
    const samples = play(motion, 'surprised', 5000, 1200);
    const scale = samples.map((s) => s.m.left.sx);
    // No jump on the first frame: the pop starts from where the face was.
    expect(Math.abs(scale[0]! - 1)).toBeLessThan(0.02);
    const peak = Math.max(...scale.slice(0, 15));
    expect(peak).toBeGreaterThan(1.04);
    expect(Math.abs(scale.at(-1)! - 1)).toBeLessThan(0.005);
  });

  it('happy hops when it appears and then rests', () => {
    const motion = settledIn('idle');
    const samples = play(motion, 'happy', 5000, 1500);
    const oy = samples.map((s) => s.m.mouth.oy);
    expect(Math.min(...oy.slice(0, 20))).toBeLessThan(-MOTION.bounceHeight * 0.4);
    expect(Math.abs(oy.at(-1)!)).toBeLessThan(0.001);
  });

  it('angry trembles, but only by about a pixel', () => {
    const samples = play(settledIn('angry'), 'angry', 5000, 1000);
    const ox = samples.map((s) => s.m.left.ox);
    expect(range(ox)).toBeGreaterThan(MOTION.trembleAmount);
    // On an 800 px tall face that stays under 3 px either way.
    expect(Math.max(...ox.map(Math.abs)) * 800).toBeLessThan(3);
    // The eyes don't shake in lockstep.
    expect(samples.some((s) => Math.abs(s.m.left.ox - s.m.right.ox) > MOTION.trembleAmount * 0.3)).toBe(true);
  });

  it('sad sinks slowly instead of dropping', () => {
    const motion = settledIn('idle');
    const samples = play(motion, 'sad', 5000, 5000);
    const oyAt = (ms: number) => samples.find((s) => s.t >= 5000 + ms)!.m.mouth.oy;
    const sink = MOTION.sadSink * 0.6;
    expect(oyAt(200)).toBeLessThan(sink * 0.3);
    expect(oyAt(4900)).toBeGreaterThan(sink * 0.9);
    expect(samples.at(-1)!.m.left.oy).toBeGreaterThan(0);
  });

  it('leaving sad lifts back smoothly, with no frame-to-frame jump', () => {
    const motion = settledIn('sad');
    const samples = play(motion, 'idle', 5000, 1500);
    for (let i = 1; i < samples.length; i += 1) {
      expect(Math.abs(samples[i]!.m.left.oy - samples[i - 1]!.m.left.oy)).toBeLessThan(MOTION.sadSink * 0.1);
    }
    expect(Math.abs(samples.at(-1)!.m.left.oy)).toBeLessThan(0.002);
  });

  it('smug lowers one upper lid, keeping its bottom edge', () => {
    const m = play(settledIn('smug'), 'smug', 5000, 20).at(-1)!.m;
    expect(m.left.sy).toBeCloseTo(1, 1);
    expect(m.right.sy).toBeLessThan(m.left.sy - 0.1);
    expect(m.right.pivotY).toBeCloseTo(1, 2);
  });

  it('thinking squints one eye more than the other and lets the eyes drift', () => {
    const samples = play(settledIn('thinking'), 'thinking', 5000, 6500);
    const last = samples.at(-1)!.m;
    expect(last.right.sy - last.left.sy).toBeGreaterThan(0.1);
    expect(range(samples.map((s) => s.m.left.ox))).toBeGreaterThan(MOTION.thinkDrift);
  });

  it('looking sideways turns the head: the near eye grows, the far eye narrows', () => {
    const lookRight = play(settledIn('idle'), 'idle', 5000, 20, 0.8).at(-1)!.m;
    expect(lookRight.left.sx).toBeGreaterThan(1.02);
    expect(lookRight.right.sx).toBeLessThan(0.92);
    expect(lookRight.mouth.ox).toBeGreaterThan(0);
    const lookLeft = play(settledIn('idle'), 'idle', 5000, 20, -0.8).at(-1)!.m;
    expect(lookLeft.right.sx).toBeGreaterThan(1.02);
    expect(lookLeft.left.sx).toBeLessThan(0.92);
    expect(lookLeft.mouth.ox).toBeLessThan(0);
  });

  it('stays subtle for every expression and gaze: a character, not a cartoon', () => {
    for (const expression of EXPRESSIONS) {
      for (const gaze of [-1, 0, 1]) {
        const motion = createExpressionMotion();
        for (const { m } of play(motion, expression, 0, 3000, gaze)) {
          for (const shape of [m.left, m.right, m.mouth]) {
            expect(shape.sx).toBeGreaterThan(0.75);
            expect(shape.sx).toBeLessThan(1.15);
            expect(shape.sy).toBeGreaterThan(0.75);
            expect(shape.sy).toBeLessThan(1.15);
            expect(Math.abs(shape.ox)).toBeLessThan(0.05);
            expect(Math.abs(shape.oy)).toBeLessThan(0.05);
          }
        }
      }
    }
  });

  it('holds still while the FX editor shows the true shapes', () => {
    const motion = settledIn('smug');
    const m = play(motion, null, 5000, 3000, 0.9).at(-1)!.m;
    for (const shape of [m.left, m.right, m.mouth]) {
      expect(shape.sx).toBeCloseTo(1, 3);
      expect(shape.sy).toBeCloseTo(1, 3);
      expect(shape.ox).toBeCloseTo(0, 3);
      expect(shape.oy).toBeCloseTo(0, 3);
    }
  });
});

describe('shape transforms for the shader', () => {
  it('a lid lowered about the bottom edge keeps that edge where it was', () => {
    const motion = createFaceMotion();
    motion.right = { sx: 1, sy: 0.8, pivotY: 1, ox: 0, oy: 0 };
    const centers = [{ cx: 100, cy: 200, halfH: 50 }, { cx: 400, cy: 200, halfH: 50 }, { cx: 250, cy: 400, halfH: 20 }];
    const out = new Float32Array(12);
    packShapeTransforms(motion, centers, 800, out);
    const mapY = (y: number) => y * out[5]! + out[7]!;
    expect(mapY(250)).toBeCloseTo(250, 4); // bottom edge stays
    expect(mapY(150)).toBeCloseTo(170, 4); // top edge comes down by 20% of the height
    // Untouched shapes map onto themselves.
    expect(out[0]).toBe(1);
    expect(out[2]).toBe(0);
  });

  it('offsets scale with the face, so the mini head moves in proportion', () => {
    const motion = createFaceMotion();
    motion.mouth.oy = 0.02;
    const centers = [{ cx: 0, cy: 0, halfH: 1 }, { cx: 0, cy: 0, halfH: 1 }, { cx: 0, cy: 0, halfH: 1 }];
    const big = new Float32Array(12);
    const small = new Float32Array(12);
    packShapeTransforms(motion, centers, 800, big);
    packShapeTransforms(motion, centers, 200, small);
    expect(big[11]).toBeCloseTo(16, 4);
    expect(small[11]).toBeCloseTo(4, 4);
  });
});
