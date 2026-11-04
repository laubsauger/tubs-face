import type { PixelGridPoint } from './pixel-grid.js';

// Expression changes used to swap the whole pixel grid in one frame, so the
// face jumped from one look to the next. A morph pairs the old pixels with
// the new ones, shape by shape, and lets them flow across instead. Pixels
// without a partner grow in or shrink away at the nearest edge.
//
// Every expression's grid has the same pixel pitch, so with the two shapes'
// centres laid on top of each other most pixels have a partner right under
// them. Pairing nearest first keeps the flow parallel (no pixels crossing
// paths); what is left over sits on the rim, where one shape sticks out past
// the other.

/** Floats per pixel in the GPU instance buffer: x, y, hueOff, brightOff, group, scale, overrideH, overrideS. */
export const INSTANCE_FLOATS = 8;
// One morph record: x0 y0 s0 x1 y1 s1 delay group hueOff brightOff ovH0 ovS0 ovH1 ovS1.
const RECORD_FLOATS = 14;
// Farthest a pixel travels to a partner, in pixel pitches (after centring).
// Past that it shrinks away and another grows in, instead of flying across
// the shape over its neighbours.
const PAIR_REACH_PITCHES = 3;
// Room for the candidate index in a packed sort key.
const CANDIDATE_SLOTS = 2 ** 24;
// Share of the stagger that follows the distance from the shape centre (the
// rest is random), so the change ripples outward without looking mechanical.
const STAGGER_RADIAL_SHARE = 0.85;
/** A morphing pixel this small is invisible; a snapshot leaves it out. */
const MIN_VISIBLE_SCALE = 0.02;

export interface MorphTiming {
  durationMs: number;
  /** Latest start of any one pixel; each pixel travels for durationMs - staggerMs. */
  staggerMs: number;
}

export interface MorphPlan {
  count: number;
  data: Float32Array;
  durationMs: number;
  moveMs: number;
}

export function createMorphPlan(): MorphPlan {
  return { count: 0, data: new Float32Array(0), durationMs: 0, moveMs: 1 };
}

export function easeOutCubic(t: number): number {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const inv = 1 - c;
  return 1 - inv * inv * inv;
}

/** Eased progress (0..1) of one pixel that starts after delayMs and travels for moveMs. */
export function morphProgress(elapsedMs: number, delayMs: number, moveMs: number): number {
  return easeOutCubic((elapsedMs - delayMs) / moveMs);
}

/**
 * Plans the flow from `from` to `to` (pixel pitch `pitch`, size plus gap),
 * reusing plan's buffer when it is big enough. Paired pixels in `to` take
 * over their partner's colour jitter, so nothing flickers when the morph
 * hands over to the static grid.
 */
export function planMorph(from: readonly PixelGridPoint[], to: PixelGridPoint[], timing: MorphTiming, plan: MorphPlan, pitch: number): MorphPlan {
  const maxRecords = from.length + to.length;
  if (plan.data.length < maxRecords * RECORD_FLOATS) {
    plan.data = new Float32Array(maxRecords * RECORD_FLOATS);
  }
  plan.durationMs = timing.durationMs;
  plan.moveMs = Math.max(1, timing.durationMs - timing.staggerMs);

  const groups = new Map<number, { from: number[]; to: number[] }>();
  const groupOf = (group: number) => {
    let sets = groups.get(group);
    if (!sets) {
      sets = { from: [], to: [] };
      groups.set(group, sets);
    }
    return sets;
  };
  for (const [index, pixel] of from.entries()) groupOf(pixel.group).from.push(index);
  for (const [index, pixel] of to.entries()) groupOf(pixel.group).to.push(index);

  let count = 0;
  for (const [group, sets] of groups) {
    count = planGroup(from, to, sets.from, sets.to, group, timing.staggerMs, Math.max(1, pitch), plan.data, count);
  }
  plan.count = count;
  return plan;
}

/** Writes this frame's pixels as GPU instances into out; returns how many. */
export function writeMorphFrame(plan: MorphPlan, elapsedMs: number, out: Float32Array): number {
  const data = plan.data;
  for (let i = 0; i < plan.count; i += 1) {
    const r = i * RECORD_FLOATS;
    const raw = (elapsedMs - data[r + 6]!) / plan.moveMs;
    const p = easeOutCubic(raw);
    // The colour (heart pink, tear blue) switches halfway through each pixel's own move.
    const late = raw >= 0.5;
    const o = i * INSTANCE_FLOATS;
    out[o] = data[r]! + (data[r + 3]! - data[r]!) * p;
    out[o + 1] = data[r + 1]! + (data[r + 4]! - data[r + 1]!) * p;
    out[o + 2] = data[r + 8]!;
    out[o + 3] = data[r + 9]!;
    out[o + 4] = data[r + 7]!;
    out[o + 5] = data[r + 2]! + (data[r + 5]! - data[r + 2]!) * p;
    out[o + 6] = late ? data[r + 12]! : data[r + 10]!;
    out[o + 7] = late ? data[r + 13]! : data[r + 11]!;
  }
  return plan.count;
}

/** The visible pixels as they are drawn at elapsedMs: where a morph that interrupts this one starts. */
export function snapshotMorph(plan: MorphPlan, elapsedMs: number): PixelGridPoint[] {
  const data = plan.data;
  const pixels: PixelGridPoint[] = [];
  for (let i = 0; i < plan.count; i += 1) {
    const r = i * RECORD_FLOATS;
    const raw = (elapsedMs - data[r + 6]!) / plan.moveMs;
    const p = easeOutCubic(raw);
    const scale = data[r + 2]! + (data[r + 5]! - data[r + 2]!) * p;
    if (scale < MIN_VISIBLE_SCALE) continue;
    const late = raw >= 0.5;
    pixels.push({
      x: data[r]! + (data[r + 3]! - data[r]!) * p,
      y: data[r + 1]! + (data[r + 4]! - data[r + 1]!) * p,
      group: data[r + 7]!,
      scale,
      hueOff: data[r + 8]!,
      brightOff: data[r + 9]!,
      overrideH: late ? data[r + 12]! : data[r + 10]!,
      overrideS: late ? data[r + 13]! : data[r + 11]!,
    });
  }
  return pixels;
}

/** Packs a static grid as GPU instances into out; returns how many. */
export function packPixels(pixels: readonly PixelGridPoint[], out: Float32Array): number {
  for (let i = 0; i < pixels.length; i += 1) {
    const pixel = pixels[i]!;
    const o = i * INSTANCE_FLOATS;
    out[o] = pixel.x;
    out[o + 1] = pixel.y;
    out[o + 2] = pixel.hueOff;
    out[o + 3] = pixel.brightOff;
    out[o + 4] = pixel.group;
    out[o + 5] = pixel.scale;
    out[o + 6] = pixel.overrideH;
    out[o + 7] = pixel.overrideS;
  }
  return pixels.length;
}

interface Frame {
  cx: number;
  cy: number;
  /** Distance of the farthest pixel from the centre, for the stagger. */
  reach: number;
}

function planGroup(
  from: readonly PixelGridPoint[],
  to: PixelGridPoint[],
  fromIdx: number[],
  toIdx: number[],
  group: number,
  staggerMs: number,
  pitch: number,
  data: Float32Array,
  start: number,
): number {
  let count = start;
  // A shape that only exists on one side (tears) grows or shrinks in place.
  if (fromIdx.length === 0 || toIdx.length === 0) {
    for (const index of fromIdx) {
      const f = from[index]!;
      count = writeRecord(data, count, f.x, f.y, f.scale, f.x, f.y, 0, delay(staggerMs, 0.5), group, f, f);
    }
    for (const index of toIdx) {
      const t = to[index]!;
      count = writeRecord(data, count, t.x, t.y, 0, t.x, t.y, 1, delay(staggerMs, 0.5), group, t, t);
    }
    return count;
  }

  const fFrame = frameOf(from, fromIdx);
  const tFrame = frameOf(to, toIdx);
  // Old pixel positions moved into the new shape's frame.
  const dx = tFrame.cx - fFrame.cx;
  const dy = tFrame.cy - fFrame.cy;
  const reach = PAIR_REACH_PITCHES * pitch;

  // Candidate pairs within reach, found through a coarse grid of the new pixels.
  const cells = new Map<number, number[]>();
  const cellKey = (x: number, y: number) => (Math.floor(x / reach) + 4096) * 8192 + (Math.floor(y / reach) + 4096);
  for (const [k, index] of toIdx.entries()) {
    const t = to[index]!;
    const key = cellKey(t.x, t.y);
    const cell = cells.get(key);
    if (cell) cell.push(k);
    else cells.set(key, [k]);
  }
  const reach2 = reach * reach;
  const pairDist2: number[] = [];
  const pairFrom: number[] = [];
  const pairTo: number[] = [];
  for (const [i, index] of fromIdx.entries()) {
    const f = from[index]!;
    const x = f.x + dx;
    const y = f.y + dy;
    const cellX = Math.floor(x / reach);
    const cellY = Math.floor(y / reach);
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const cell = cells.get((cellX + ox + 4096) * 8192 + (cellY + oy + 4096));
        if (!cell) continue;
        for (const k of cell) {
          const t = to[toIdx[k]!]!;
          const d2 = (t.x - x) ** 2 + (t.y - y) ** 2;
          if (d2 > reach2) continue;
          pairDist2.push(d2);
          pairFrom.push(i);
          pairTo.push(k);
        }
      }
    }
  }

  // Nearest pairs first: pixels that overlap barely move, and nobody crosses.
  // Distance and candidate index share one number, so the sort is a fast
  // native numeric one (a comparator sort cost a dropped frame on big screens).
  const order = new Float64Array(pairDist2.length);
  for (let c = 0; c < pairDist2.length; c += 1) {
    order[c] = Math.round(pairDist2[c]! * 64) * CANDIDATE_SLOTS + c;
  }
  order.sort();
  const partnerOfFrom = new Int32Array(fromIdx.length).fill(-1);
  const takenTo = new Uint8Array(toIdx.length);
  for (const key of order) {
    const c = key % CANDIDATE_SLOTS;
    const i = pairFrom[c]!;
    const k = pairTo[c]!;
    if (partnerOfFrom[i] !== -1 || takenTo[k]) continue;
    partnerOfFrom[i] = k;
    takenTo[k] = 1;
  }

  for (const [i, index] of fromIdx.entries()) {
    const f = from[index]!;
    const wait = delay(staggerMs, Math.hypot(f.x - fFrame.cx, f.y - fFrame.cy) / fFrame.reach);
    const k = partnerOfFrom[i]!;
    if (k >= 0) {
      const t = to[toIdx[k]!]!;
      // The new pixel keeps its partner's colour jitter, so the hand-over is seamless.
      t.hueOff = f.hueOff;
      t.brightOff = f.brightOff;
      count = writeRecord(data, count, f.x, f.y, f.scale, t.x, t.y, 1, wait, group, f, t);
    } else {
      // Left over: shrink away into the nearest edge of the new shape.
      const edge = to[nearest(to, toIdx, f.x + dx, f.y + dy)]!;
      count = writeRecord(data, count, f.x, f.y, f.scale, edge.x, edge.y, 0, wait, group, f, f);
    }
  }
  for (const [k, index] of toIdx.entries()) {
    if (takenTo[k]) continue;
    // New: grow out of the nearest edge of the old shape.
    const t = to[index]!;
    const edge = from[nearest(from, fromIdx, t.x - dx, t.y - dy)]!;
    const wait = delay(staggerMs, Math.hypot(t.x - tFrame.cx, t.y - tFrame.cy) / tFrame.reach);
    count = writeRecord(data, count, edge.x, edge.y, 0, t.x, t.y, 1, wait, group, t, t);
  }
  return count;
}

/** Bounding-box centre of a shape's pixels and how far they reach from it. */
function frameOf(pixels: readonly PixelGridPoint[], indices: number[]): Frame {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const index of indices) {
    const p = pixels[index]!;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { cx, cy, reach: Math.max(1, Math.hypot(maxX - cx, maxY - cy)) };
}

function nearest(pixels: readonly PixelGridPoint[], indices: number[], x: number, y: number): number {
  let best = indices[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of indices) {
    const p = pixels[index]!;
    const distance = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/** Start delay: mostly by distance from the centre (0..1), a little random. */
function delay(staggerMs: number, radius: number): number {
  return staggerMs * (STAGGER_RADIAL_SHARE * Math.min(1, radius) + (1 - STAGGER_RADIAL_SHARE) * Math.random());
}

function writeRecord(
  data: Float32Array,
  count: number,
  x0: number,
  y0: number,
  s0: number,
  x1: number,
  y1: number,
  s1: number,
  delayMs: number,
  group: number,
  colourFrom: PixelGridPoint,
  colourTo: PixelGridPoint,
): number {
  const r = count * RECORD_FLOATS;
  data[r] = x0;
  data[r + 1] = y0;
  data[r + 2] = s0;
  data[r + 3] = x1;
  data[r + 4] = y1;
  data[r + 5] = s1;
  data[r + 6] = delayMs;
  data[r + 7] = group;
  data[r + 8] = colourFrom.hueOff;
  data[r + 9] = colourFrom.brightOff;
  data[r + 10] = colourFrom.overrideH;
  data[r + 11] = colourFrom.overrideS;
  data[r + 12] = colourTo.overrideH;
  data[r + 13] = colourTo.overrideS;
  return count + 1;
}
