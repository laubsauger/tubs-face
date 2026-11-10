// What a head wears (config propMain / propSmall): a hat drawn as part of the
// pixel face, on the face's own pixel grid and through the same shader as the
// eyes and mouth. So it moves with the face, glitches and takes the mood's
// colour like the rest of it, and it is in every published stream: nothing
// downstream (studio surfaces, studio-world) needs to know props exist.
//
// The art is a few simple shapes in face units (the face's viewBox), sampled
// at each grid cell like the eyes are, so it stays in the face's pixel style
// at any size or pixel setting. One colour with lighter and darker shades, as
// the face is; the accent is the head's colour turned a little round the hue.

import { PROPS, type PropId } from '../../shared/contracts/config.js';
import type { ShapeCenter } from './pixel-grid.js';

/** Pixel groups after the eyes (0, 1), mouth (2) and tears (3, 4); the shader moves each its own way. */
export const PROP_GROUP = 5;
/** Turns round the prop's middle, seen from the front (the propeller). */
export const PROP_SPIN_GROUP = 6;
/** Swings side to side (the party hat's tassel). */
export const PROP_SWING_GROUP = 7;

/**
 * Space between the eyes' tops and the prop's base, in face units (about two
 * pixel rows): touching them, the prop would read as part of an eye.
 */
export const PROP_GAP = 2.6;
/** Most the prop tilts when one eye's top drops below the other's (smug, thinking), in radians. */
export const PROP_MAX_TILT = 0.14;

/** Shades inside a prop: lightness (percent) and hue (degrees) offsets from the head's colour. */
export const PROP_TONES = {
  body: { hue: 0, light: 0 },
  dark: { hue: 0, light: -26 },
  light: { hue: 0, light: 16 },
  accent: { hue: 42, light: 4 },
} as const;
export type PropTone = keyof typeof PROP_TONES;

type Mark = PropTone | { tone: PropTone; group: number } | null;

interface PropArt {
  /** Size in face units: an eye is 14.6 wide and 22.5 tall, both eyes span 55. */
  width: number;
  height: number;
  /** What is at (x, y): x from the prop's middle (right positive), y up from its base, in face units. */
  at(x: number, y: number): Mark;
}

const circle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const odd = (n: number) => ((Math.floor(n) % 2) + 2) % 2 === 1;

const PARTY_HAT: PropArt = {
  width: 17,
  height: 21.6,
  at(x, y) {
    // Worn a little askew: the tip leans right, the tassel on it swings.
    const tipX = 2.6;
    const tipY = 16.4;
    if (circle(x, y, tipX, tipY + 2.4, 2.8)) return { tone: 'light', group: PROP_SWING_GROUP };
    if (y > tipY) return null;
    const left = -8.5 + (tipX + 8.5) * (y / tipY);
    const right = 8.5 + (tipX - 8.5) * (y / tipY);
    if (x < left || x > right) return null;
    if (y < 2.2) return 'light';
    return odd((y + x * 0.4) / 2.6) ? 'accent' : 'body';
  },
};

const TOP_HAT: PropArt = {
  width: 28,
  height: 19.4,
  at(x, y) {
    const brim = 2.6;
    if (y < brim) return Math.abs(x) <= 14 ? 'body' : null;
    if (Math.abs(x) > 8.8) return null;
    if (y < brim + 3) return 'dark';
    if (x > -7.4 && x < -5.2 && y > brim + 4.4 && y < 17.6) return 'light';
    return 'body';
  },
};

const WITCH_HAT: PropArt = {
  width: 33,
  height: 23.6,
  at(x, y) {
    const brim = 2.4;
    if (y < brim) {
      // Thinner toward the ends.
      const reach = Math.abs(x) / 16.5;
      return reach <= 1 && y < brim * (1 - reach ** 4) + 0.6 ? 'body' : null;
    }
    const t = (y - brim) / (this.height - brim);
    // A straight cone whose top half bends over to the right.
    const middle = t < 0.45 ? 0 : 7.5 * ((t - 0.45) / 0.55) ** 2;
    const half = 7.6 * (1 - t);
    if (half < 0.5 || Math.abs(x - middle) > half) return null;
    if (y < brim + 2.8) return Math.abs(x) < 2 ? 'light' : 'accent';
    return 'body';
  },
};

const CROWN: PropArt = {
  width: 22,
  height: 13.4,
  at(x, y) {
    const band = 4.8;
    if (Math.abs(x) > 11) return null;
    if (y < band) {
      for (const jewel of [-6.4, 0, 6.4]) if (circle(x, y, jewel, band / 2, 1.4)) return 'accent';
      return 'body';
    }
    // Three points (the middle and both ends), each with a ball on top.
    const peaks = [-9.8, 0, 9.8];
    for (const peak of peaks) if (circle(x, y, peak, 11.8, 1.5)) return 'light';
    const nearest = Math.min(...peaks.map((peak) => Math.abs(x - peak)));
    return y < 11 - nearest * 1.2 ? 'body' : null;
  },
};

const PROPELLER_CAP: PropArt = {
  width: 22,
  height: 11.8,
  at(x, y) {
    const dome = 8;
    if (y < dome && (x / 11) ** 2 + (y / dome) ** 2 <= 1) {
      if (y < 1.8) return 'light';
      // Four panels like a beanie's, curving in to meet at the button on top.
      const across = x / (11 * Math.sqrt(1 - (y / dome) ** 2));
      return odd((across + 1) * 2) ? 'accent' : 'body';
    }
    if (y < dome + 1.6) return Math.abs(x) < 1 ? 'body' : null;
    // Two blades of different shades, so one passing the other reads as a turn.
    if (y < 11.8 && Math.abs(x) <= 9) return { tone: Math.abs(x) < 1.2 ? 'body' : x < 0 ? 'light' : 'accent', group: PROP_SPIN_GROUP };
    return null;
  },
};

const ART: Record<Exclude<PropId, 'none'>, PropArt> = {
  'party-hat': PARTY_HAT,
  'top-hat': TOP_HAT,
  'witch-hat': WITCH_HAT,
  crown: CROWN,
  'propeller-cap': PROPELLER_CAP,
};

/** An id from the config, or 'none' for anything this client doesn't know. */
export function propOf(value: unknown): PropId {
  return (PROPS as readonly unknown[]).includes(value) ? (value as PropId) : 'none';
}

function artOf(prop: PropId): PropArt | null {
  return prop === 'none' ? null : ART[prop] ?? null;
}

/** How far the prop reaches above the eyes' tops at rest, in face units (0 without one). */
export function propHeadroom(prop: PropId): number {
  const art = artOf(prop);
  return art ? PROP_GAP + art.height : 0;
}

/** The prop's size in face units (0 x 0 without one). */
export function propSize(prop: PropId): { width: number; height: number } {
  const art = artOf(prop);
  return { width: art?.width ?? 0, height: art?.height ?? 0 };
}

export interface PropPixel {
  /** Top-left corner, like the face's pixels. */
  x: number;
  y: number;
  group: number;
  tone: PropTone;
}

/**
 * The prop's pixels on a grid of size + gap, its base's middle at (baseX,
 * baseY) and scaleX, scaleY pixels to a face unit. Like each eye, the prop
 * gets its own grid, centred in its box.
 */
export function rasterizeProp(prop: PropId, baseX: number, baseY: number, scaleX: number, scaleY: number, size: number, gap: number): PropPixel[] {
  const art = artOf(prop);
  if (!art) return [];
  const stride = size + gap;
  const w = art.width * scaleX;
  const h = art.height * scaleY;
  const cols = Math.max(1, Math.floor(w / stride));
  const rows = Math.max(1, Math.floor(h / stride));
  const left = baseX - w / 2 + (w - cols * stride + gap) / 2;
  const top = baseY - h + (h - rows * stride + gap) / 2;
  const pixels: PropPixel[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const px = left + c * stride;
      const py = top + r * stride;
      const mark = art.at((px + size / 2 - baseX) / scaleX, (baseY - py - size / 2) / scaleY);
      if (!mark) continue;
      pixels.push(typeof mark === 'string'
        ? { x: px, y: py, group: PROP_GROUP, tone: mark }
        : { x: px, y: py, group: mark.group, tone: mark.tone });
    }
  }
  return pixels;
}

/** Floats in the prop's uniforms: pivot x, y; cos, sin of the tilt; offset x, y; two unused. */
export const PROP_TRANSFORM_FLOATS = 8;

/** Where a prop is drawn at rest: the middle of its base, and the eyes' tops it sits above. */
export interface PropBase {
  x: number;
  y: number;
  eyeTop: number;
}

/**
 * How the prop moves this frame. It sits on the eyes, so it follows their top
 * edges: down onto narrowed eyes (sad, smug, asleep) and back up as they
 * open, gliding with the expression's morph, and with the living motion
 * (breath, the happy hop, the surprised pop, the sad sink). It tilts when one
 * top edge drops below the other (smug's lowered lid, thinking's squint). A
 * blink doesn't move it. `transforms` are the eyes' and mouth's (sx, sy, tx,
 * ty), `centers` the shapes as drawn; the pivot is the middle of the prop's
 * base. The gaze moves it with the eyes in the shader.
 */
export function packPropTransform(base: PropBase | null, transforms: Float32Array, centers: readonly ShapeCenter[], out: Float32Array): void {
  out.fill(0);
  out[2] = 1;
  if (!base) return;
  const left = centers[0];
  const right = centers[1];
  if (!left || !right) return;
  // Where each eye's top edge (from the top at rest) and middle go.
  const lift = (center: ShapeCenter, at: number) => (center.cy - center.halfH) * transforms[at + 1]! + transforms[at + 3]! - base.eyeTop;
  const shift = (center: ShapeCenter, at: number) => center.cx * (transforms[at]! - 1) + transforms[at + 2]!;
  const dyLeft = lift(left, 0);
  const dyRight = lift(right, 4);
  const span = Math.max(1, right.cx - left.cx);
  const tilt = Math.max(-PROP_MAX_TILT, Math.min(PROP_MAX_TILT, Math.atan2(dyRight - dyLeft, span)));
  out[0] = base.x;
  out[1] = base.y;
  out[2] = Math.cos(tilt);
  out[3] = Math.sin(tilt);
  out[4] = (shift(left, 0) + shift(right, 4)) / 2;
  out[5] = (dyLeft + dyRight) / 2;
}
