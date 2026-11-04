import { describe, expect, it } from 'vitest';
import type { ExpressionName } from '../../shared/contracts/config.js';
import type { AppState } from '../state/app-state.js';
import { DEFAULT_CONFIG, MORPH } from './constants.js';
import { INSTANCE_FLOATS, createMorphPlan, morphProgress, planMorph, snapshotMorph, writeMorphFrame, type MorphPlan } from './morph.js';
import { buildPixelGrid, type PixelGridPoint } from './pixel-grid.js';

// Expression changes should look like the face moving, not like a slide
// change: pixels flow from the old shape to the new one, nothing pops in or
// out, and the morph hands over to the static grid without a flicker.

const SIZE = 16;
const GAP = 5;
const PITCH = SIZE + GAP;

function layout(expression: ExpressionName): PixelGridPoint[] {
  const state = { sleeping: false, currentExpression: expression } as AppState;
  return buildPixelGrid(state, DEFAULT_CONFIG, 1280, 800, SIZE, GAP).pixelGrid;
}

interface Drawn { x: number; y: number; group: number; scale: number; hueOff: number }

function frame(plan: MorphPlan, elapsedMs: number): Drawn[] {
  const out = new Float32Array(plan.count * INSTANCE_FLOATS);
  const count = writeMorphFrame(plan, elapsedMs, out);
  const drawn: Drawn[] = [];
  for (let i = 0; i < count; i += 1) {
    const o = i * INSTANCE_FLOATS;
    drawn.push({ x: out[o]!, y: out[o + 1]!, hueOff: out[o + 2]!, group: out[o + 4]!, scale: out[o + 5]! });
  }
  return drawn;
}

// Positions go through a Float32Array on their way to the GPU.
const key = (p: { x: number; y: number; group: number }) => `${p.group}|${Math.fround(p.x).toFixed(2)}|${Math.fround(p.y).toFixed(2)}`;
const visibleKeys = (pixels: Array<Drawn | PixelGridPoint>) => pixels.filter((p) => p.scale > 0).map(key).sort();

const CHANGES: Array<[ExpressionName, ExpressionName]> = [
  ['idle', 'happy'],
  ['idle', 'surprised'],
  ['happy', 'sad'],
  ['smug', 'love'],
  ['sad', 'crying'],
  ['crying', 'idle'],
  ['angry', 'thinking'],
];

describe('morph pairing', () => {
  it.each(CHANGES)('%s -> %s starts exactly on the old face and lands exactly on the new one', (a, b) => {
    const from = layout(a);
    const to = layout(b);
    const plan = planMorph(from, to, MORPH, createMorphPlan(), PITCH);

    expect(visibleKeys(frame(plan, 0))).toEqual(visibleKeys(from));
    expect(visibleKeys(frame(plan, MORPH.durationMs))).toEqual(visibleKeys(to));

    // Every pixel is accounted for once: pairs, plus the ones that only leave or only arrive.
    const start = frame(plan, 0);
    const end = frame(plan, MORPH.durationMs);
    const paired = start.filter((p, i) => p.scale > 0 && end[i]!.scale > 0).length;
    expect(plan.count).toBe(from.length + to.length - paired);
    expect(paired).toBeGreaterThan(Math.min(from.length, to.length) * 0.6);
  });

  it.each(CHANGES)('%s -> %s keeps each pixel within its own eye or the mouth', (a, b) => {
    const from = layout(a);
    const to = layout(b);
    const plan = planMorph(from, to, MORPH, createMorphPlan(), PITCH);
    const fromByKey = new Map(from.map((p) => [key(p), p.group]));
    const toByKey = new Map(to.map((p) => [key(p), p.group]));
    const start = frame(plan, 0);
    const end = frame(plan, MORPH.durationMs);
    for (const [i, s] of start.entries()) {
      const e = end[i]!;
      if (s.scale > 0) expect(fromByKey.get(key(s))).toBe(s.group);
      if (e.scale > 0) expect(toByKey.get(key(e))).toBe(e.group);
    }
  });

  it('pixels without a partner shrink into the new shape and grow out of the old one', () => {
    for (const [a, b] of CHANGES) {
      const from = layout(a);
      const to = layout(b);
      const plan = planMorph(from, to, MORPH, createMorphPlan(), PITCH);
      const start = frame(plan, 0);
      const end = frame(plan, MORPH.durationMs);
      const fromKeys = new Set(from.map(key));
      const toKeys = new Set(to.map(key));
      const fromGroups = new Set(from.map((p) => p.group));
      for (const [i, s] of start.entries()) {
        const e = end[i]!;
        // Leaving: ends on a pixel of the new shape, at nothing.
        if (e.scale === 0) expect(toKeys.has(key(e)) || !to.some((p) => p.group === e.group)).toBe(true);
        // Arriving: starts on a pixel of the old shape (or in place, for a shape that is new, like tears).
        if (s.scale === 0 && fromGroups.has(s.group)) expect(fromKeys.has(key(s))).toBe(true);
      }
    }
  });

  it('the morph hands over to the static grid without a colour flicker', () => {
    const from = layout('idle');
    const to = layout('happy');
    const plan = planMorph(from, to, MORPH, createMorphPlan(), PITCH);
    const toHue = new Map(to.map((p) => [key(p), Math.fround(p.hueOff)]));
    for (const p of frame(plan, MORPH.durationMs).filter((d) => d.scale > 0)) {
      expect(p.hueOff).toBe(toHue.get(key(p)));
    }
  });
});

describe('morph timing', () => {
  it('waits out its delay, eases out, and lands at exactly 1', () => {
    expect(morphProgress(10, 40, 200)).toBe(0);
    expect(morphProgress(40, 40, 200)).toBe(0);
    expect(morphProgress(240, 40, 200)).toBe(1);
    expect(morphProgress(1000, 40, 200)).toBe(1);
    // Ease-out: most of the way there after the first third.
    expect(morphProgress(40 + 200 / 3, 40, 200)).toBeGreaterThan(0.6);
    let last = 0;
    for (let t = 0; t <= 260; t += 5) {
      const p = morphProgress(t, 40, 200);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it('lasts long enough to see and short enough to keep up with speech', () => {
    expect(MORPH.durationMs).toBeGreaterThanOrEqual(220);
    expect(MORPH.durationMs).toBeLessThanOrEqual(320);
    // Each pixel still gets most of the time to travel.
    expect(MORPH.staggerMs).toBeLessThan(MORPH.durationMs / 3);
  });

  it('is in motion halfway through: pixels are between the two faces', () => {
    const from = layout('idle');
    const to = layout('sad');
    const plan = planMorph(from, to, MORPH, createMorphPlan(), PITCH);
    const mid = new Set(visibleKeys(frame(plan, MORPH.durationMs / 2)));
    const onOld = visibleKeys(from).filter((k) => mid.has(k)).length;
    expect(onOld).toBeLessThan(from.length / 2);
  });
});

describe('interrupted morph', () => {
  it('a new expression mid-morph starts from where the pixels are, not from the old grid', () => {
    const idle = layout('idle');
    const happy = layout('happy');
    const plan = planMorph(idle, happy, MORPH, createMorphPlan(), PITCH);
    const midway = 120;
    const onScreen = frame(plan, midway).filter((p) => p.scale >= 0.02);
    const snapshot = snapshotMorph(plan, midway);
    expect(snapshot.map(key).sort()).toEqual(onScreen.map(key).sort());

    // Reusing the same plan object, as the renderer does.
    const surprised = layout('surprised');
    planMorph(snapshot, surprised, MORPH, plan, PITCH);
    const restart = frame(plan, 0).filter((p) => p.scale > 0);
    expect(restart.map(key).sort()).toEqual(onScreen.map(key).sort());
    // Same sizes too: a half-grown pixel carries on from half-grown.
    const scaleAt = new Map(onScreen.map((p) => [key(p), Math.fround(p.scale)]));
    for (const p of restart) expect(p.scale).toBeCloseTo(scaleAt.get(key(p))!, 5);

    expect(visibleKeys(frame(plan, MORPH.durationMs))).toEqual(visibleKeys(surprised));
  });
});
