// What a head wears (config propMain / propSmall): a hat, or a whole look
// (Alan Watts: hair, brows, moustache and beard), drawn as part of the pixel
// face, on the face's own pixel grid and through the same shader as the eyes
// and mouth. So it moves with the face, glitches and takes the mood's colour
// like the rest of it, and it is in every published stream: nothing
// downstream (studio surfaces, studio-world) needs to know props exist.
//
// The art is a few simple shapes in face units (the face's viewBox), sampled
// at each grid cell like the eyes are, so it stays in the face's pixel style
// at any size or pixel setting. One colour with lighter and darker shades, as
// the face is; the accent is the head's colour turned a little round the hue,
// and hair is the head's colour washed out to grey.

import { PROPS, type PropId } from '../../shared/contracts/config.js';
import type { FaceMotion } from './expression-motion.js';
import type { ShapeCenter } from './pixel-grid.js';

/** Pixel groups after the eyes (0, 1), mouth (2) and tears (3, 4); the shader moves each its own way. */
export const PROP_GROUP = 5;
/** Turns round the prop's middle, seen from the front (the propeller). */
export const PROP_SPIN_GROUP = 6;
/** Swings side to side (the party hat's tassel). */
export const PROP_SWING_GROUP = 7;
/** Moves with the head, not the lids (hair). */
export const PROP_HEAD_GROUP = 8;
/** On the mouth's top edge (a moustache). */
export const PROP_LIP_GROUP = 9;
/** On its bottom edge (a beard). */
export const PROP_JAW_GROUP = 10;

/**
 * What a part of a prop sits on, and so moves with:
 * - eyes: above the eyes' tops, following them (a hat, brows);
 * - head: the same place, but moving with the head (hop, sink, turn), not
 *   with the lids, so it stays put while the eyes change shape (hair);
 * - lip: the mouth's top edge, which rises as the mouth opens (a moustache);
 * - jaw: its bottom edge, which drops as it opens (a beard).
 */
export type PropAnchor = 'eyes' | 'head' | 'lip' | 'jaw';
const ANCHOR_GROUP: Record<PropAnchor, number> = { eyes: PROP_GROUP, head: PROP_HEAD_GROUP, lip: PROP_LIP_GROUP, jaw: PROP_JAW_GROUP };

/**
 * Space between the eyes' tops and the prop's base, in face units (about two
 * pixel rows): touching them, the prop would read as part of an eye.
 */
export const PROP_GAP = 2.6;
/** Most the prop tilts when one eye's top drops below the other's (smug, thinking), in radians. */
export const PROP_MAX_TILT = 0.14;

/**
 * Shades inside a prop: lightness (percent) and hue (degrees) offsets from
 * the head's colour, and for hair a saturation (0..1) it is washed out to.
 */
export type PropTone = 'body' | 'dark' | 'light' | 'accent' | 'silver' | 'ash' | 'smoke' | 'white';
export const PROP_TONES: Record<PropTone, { hue: number; light: number; sat?: number }> = {
  body: { hue: 0, light: 0 },
  dark: { hue: 0, light: -26 },
  light: { hue: 0, light: 16 },
  accent: { hue: 42, light: 4 },
  silver: { hue: 0, light: 4, sat: 0.14 },
  ash: { hue: 0, light: -4, sat: 0.16 },
  smoke: { hue: 0, light: -16, sat: 0.14 },
  white: { hue: 0, light: 20, sat: 0.08 },
};

type Mark = PropTone | { tone: PropTone; group: number } | null;

interface PropArt {
  /** Size in face units: an eye is 14.6 wide and 22.5 tall, both eyes span 55. */
  width: number;
  /** How far it reaches above its base, and below it (hair down the sides, a beard). */
  height: number;
  depth?: number;
  /** What is at (x, y): x from the prop's middle (right positive), y up from its base, in face units. */
  at(x: number, y: number): Mark;
}

interface PropPart {
  anchor: PropAnchor;
  art: PropArt;
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

// Alan Watts, about 1970: long hair swept back off a high forehead and down
// past the ears, heavy brows, a dark moustache drooping into a short white
// beard. Each part sits on what it grows from, so the brows ride the eyes,
// the moustache the upper lip and the beard the jaw.

/**
 * Parted in the middle, off a high forehead, and falling past the eyes
 * (clear of them) in locks, fuller toward the shoulders. Darker than the
 * beard, as his was.
 */
const WATTS_HAIR: PropArt = {
  width: 68,
  height: 16,
  depth: 36,
  at(x, y) {
    const ax = Math.abs(x);
    const dy = y + 6;
    // Outside: a dome over the head, then down and a little out.
    const out = 32.6 + 1.4 * Math.min(1, Math.max(0, (-12 - y) / 14));
    if (dy > 0 ? (ax / 32.6) ** 2.4 + (dy / 22) ** 2.4 > 1 : ax > out) return null;
    // The forehead, high and rising to the parting, so the brows fit under it;
    // then a gap beside the eyes.
    const hairline = 15 + 2 * Math.max(0, 1 - ax / 6);
    if (dy > 0 ? (ax / 29.3) ** 3 + (dy / hairline) ** 3 < 1 : ax < 29.3) return null;
    if (ax < 0.9) return null;
    // Locks at the ends, the outer ones longest.
    const lock = Math.floor((ax - 29.3) / 1.6);
    if (y < -30 - lock * 1.6 - (lock % 2 === 1 ? 2 : 0)) return null;
    // Strands: out from the parting over the top, then straight down.
    const along = dy > 0 ? Math.atan2(dy, ax) * 8 : (ax - 29.3) / 1.6;
    return odd(along) ? 'ash' : 'smoke';
  },
};

/** Heavy: thick toward the nose, arched over the eye, thinning and dropping at the outer end. */
const WATTS_BROWS: PropArt = {
  width: 54,
  height: 4.8,
  at(x, y) {
    // 0 at a brow's inner end, 1 at its outer end.
    const u = (Math.abs(x) - 11.4) / 15.4;
    if (u < 0 || u > 1) return null;
    const bottom = u < 0.6 ? 1 : 1 - (u - 0.6) * 2;
    const top = 4.2 + 0.6 * Math.sin(Math.PI * Math.min(1, u * 1.4)) - 2.6 * u * u;
    return y >= bottom && y <= top ? 'body' : null;
  },
};

/** Bushy over the mouth, its ends drooping past the corners. */
const WATTS_MOUSTACHE: PropArt = {
  width: 22,
  height: 5.6,
  depth: 3,
  at(x, y) {
    const ax = Math.abs(x);
    if (ax > 10.8) return null;
    const top = 5.6 - (ax / 10.8) ** 2 * 3.6;
    // Clear of the mouth (about 6.3 to either side) above it; past its corners it droops.
    const bottom = Math.max(-3, ax < 7.4 ? 1.2 : 1.2 - (ax - 7.4) * 2.4);
    return y <= top && y >= bottom ? 'ash' : null;
  },
};

/** From beside the mouth to a point at the chin; whitest there, greyer at the jaw. */
const WATTS_BEARD: PropArt = {
  width: 24,
  height: 2.8,
  depth: 20,
  at(x, y) {
    const ax = Math.abs(x);
    // A row clear round the mouth, which changes shape.
    if (y > -1.1 && ax < 7.6) return null;
    const t = Math.max(0, (-y - 3) / 17);
    const half = 11.4 * Math.max(0, 1 - t ** 1.6) ** 0.9;
    if (ax > half) return null;
    return ax < half * 0.55 && y < -3 ? 'white' : 'silver';
  },
};

const hat = (art: PropArt): readonly PropPart[] => [{ anchor: 'eyes', art }];

const ART: Record<Exclude<PropId, 'none'>, readonly PropPart[]> = {
  'party-hat': hat(PARTY_HAT),
  'top-hat': hat(TOP_HAT),
  'witch-hat': hat(WITCH_HAT),
  crown: hat(CROWN),
  'propeller-cap': hat(PROPELLER_CAP),
  watts: [
    { anchor: 'head', art: WATTS_HAIR },
    { anchor: 'eyes', art: WATTS_BROWS },
    { anchor: 'lip', art: WATTS_MOUSTACHE },
    { anchor: 'jaw', art: WATTS_BEARD },
  ],
};

/** An id from the config, or 'none' for anything this client doesn't know. */
export function propOf(value: unknown): PropId {
  return (PROPS as readonly unknown[]).includes(value) ? (value as PropId) : 'none';
}

function partsOf(prop: PropId): readonly PropPart[] {
  return prop === 'none' ? [] : ART[prop] ?? [];
}

/** Where a prop's parts sit at rest: the middle of each base. 'eyes' and 'head' parts share one. */
export interface PropAnchors {
  /** Between the eyes, PROP_GAP above their tops. */
  eyes: { x: number; y: number };
  /** The middles of the mouth's top and bottom edges. */
  lip: { x: number; y: number };
  jaw: { x: number; y: number };
}

const anchorPoint = (anchors: PropAnchors, anchor: PropAnchor) => (anchor === 'head' ? anchors.eyes : anchors[anchor]);

/** The box a prop covers at rest, in the anchors' units (y down), scale units to a face unit; null without one. */
export function propBounds(prop: PropId, anchors: PropAnchors, scaleX = 1, scaleY = 1): { left: number; right: number; top: number; bottom: number } | null {
  const parts = partsOf(prop);
  if (parts.length === 0) return null;
  const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const { anchor, art } of parts) {
    const base = anchorPoint(anchors, anchor);
    box.left = Math.min(box.left, base.x - (art.width / 2) * scaleX);
    box.right = Math.max(box.right, base.x + (art.width / 2) * scaleX);
    box.top = Math.min(box.top, base.y - art.height * scaleY);
    box.bottom = Math.max(box.bottom, base.y + (art.depth ?? 0) * scaleY);
  }
  return box;
}

export interface PropPixel {
  /** Top-left corner, like the face's pixels. */
  x: number;
  y: number;
  group: number;
  tone: PropTone;
}

/**
 * The prop's pixels on a grid of size + gap, each part on its anchor and
 * scaleX, scaleY pixels to a face unit. Like each eye, each part gets its own
 * grid, centred in its box.
 */
export function rasterizeProp(prop: PropId, anchors: PropAnchors, scaleX: number, scaleY: number, size: number, gap: number): PropPixel[] {
  const pixels: PropPixel[] = [];
  const stride = size + gap;
  for (const { anchor, art } of partsOf(prop)) {
    const base = anchorPoint(anchors, anchor);
    const w = art.width * scaleX;
    const h = (art.height + (art.depth ?? 0)) * scaleY;
    const cols = Math.max(1, Math.floor(w / stride));
    const rows = Math.max(1, Math.floor(h / stride));
    const left = base.x - w / 2 + (w - cols * stride + gap) / 2;
    const top = base.y - art.height * scaleY + (h - rows * stride + gap) / 2;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const px = left + c * stride;
        const py = top + r * stride;
        const mark = art.at((px + size / 2 - base.x) / scaleX, (base.y - py - size / 2) / scaleY);
        if (!mark) continue;
        pixels.push(typeof mark === 'string'
          ? { x: px, y: py, group: ANCHOR_GROUP[anchor], tone: mark }
          : { x: px, y: py, group: mark.group, tone: mark.tone });
      }
    }
  }
  return pixels;
}

/**
 * Floats in the prop's uniforms: pivot x, y; cos, sin of the tilt; offset x,
 * y with the eyes' tops; the head's offset x, y; the mouth's offset x, its
 * top's and bottom's offsets y, and its half height as drawn before talking.
 */
export const PROP_TRANSFORM_FLOATS = 12;

/** Where a prop is drawn at rest: its pivot (the eyes' anchor), the eyes' tops, and the mouth's middle, top and bottom. */
export interface PropBase {
  x: number;
  y: number;
  eyeTop: number;
  mouthX: number;
  mouthTop: number;
  mouthBottom: number;
}

/**
 * How the prop moves this frame. Parts on the eyes follow their top edges:
 * down onto narrowed eyes (sad, smug, asleep) and back up as they open,
 * gliding with the expression's morph, and with the living motion (breath,
 * the happy hop, the surprised pop, the sad sink). They tilt when one top
 * edge drops below the other (smug's lowered lid, thinking's squint). A blink
 * doesn't move them. Hair moves with the head only, the eyes' offsets in
 * `motion` (hop, sink, turn, tremble), so the lids, a pop or a change of
 * expression leave it where it is. A moustache and a beard follow the
 * mouth's top and bottom edges as drawn; the shader adds talking.
 * `transforms` are the eyes' and mouth's (sx, sy, tx, ty) from `motion`,
 * `centers` the shapes as drawn, `faceH` the face's height; the pivot is the
 * middle of the eyes' anchor. The gaze moves each part with the eyes or the
 * mouth in the shader.
 */
export function packPropTransform(base: PropBase | null, transforms: Float32Array, centers: readonly ShapeCenter[], motion: FaceMotion, faceH: number, out: Float32Array): void {
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
  out[6] = ((motion.left.ox + motion.right.ox) / 2) * faceH;
  out[7] = ((motion.left.oy + motion.right.oy) / 2) * faceH;
  const mouth = centers[2];
  if (!mouth) return;
  const sy = transforms[9]!;
  const ty = transforms[11]!;
  out[8] = mouth.cx * transforms[8]! + transforms[10]! - base.mouthX;
  out[9] = (mouth.cy - mouth.halfH) * sy + ty - base.mouthTop;
  out[10] = (mouth.cy + mouth.halfH) * sy + ty - base.mouthBottom;
  out[11] = mouth.halfH * sy;
}
