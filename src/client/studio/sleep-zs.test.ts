import { describe, expect, it } from 'vitest';
import type { AppState } from '../state/app-state.js';
import { DEFAULT_CONFIG, GAZE_EYE_RANGE_X, GAZE_EYE_RANGE_Y } from '../glitch/constants.js';
import { STUDIO_LAYOUT, buildPixelGrid } from '../glitch/pixel-grid.js';
import { SLEEP_GAZE_MAX, SLEEP_LID_FLICKER } from '../face/sleep-life.js';
import {
  DEFAULT_GLYPH,
  STUDIO_ZZZ_COLOR,
  drawSleepZs,
  easeInOut,
  glowReach,
  layoutSleepZs,
  letterBox,
  sleepZs,
  withAlpha,
  type Box,
  type SleepingFace,
} from './sleep-zs.js';

// A studio stream carries only the canvas, so the face window's sleeping "zzz"
// (page text) is drawn into the frame. In the studio the frame is shown small
// and far away, so the Zs have to be big, sit in the empty top of the frame
// starting at the outer corner of the eye, never cover the face, and never be
// cut off: receivers show the frame and nothing else. A sleeping face keeps
// its gaze near centre (a small drift and twitches), which leaves the room
// above the eyes to the Zs.

const FRAME = 1024;

/** The sleeping face as the studio page draws it, with what the runtime reserves: the sleeping drift and the lid flicker (or the full waking gaze range). */
function sleepingFace(frame = FRAME, offsetY = 0, gaze = false): SleepingFace {
  const state = { sleeping: true, currentExpression: 'idle' } as AppState;
  const size = 8;
  const { pixelGrid } = buildPixelGrid(state, DEFAULT_CONFIG, frame, frame, size, 3, STUDIO_LAYOUT);
  const boxOf = (group: number): Box => {
    const points = pixelGrid.filter((point) => point.group === group);
    return {
      left: Math.min(...points.map((p) => p.x)) - size / 2,
      right: Math.max(...points.map((p) => p.x)) + size / 2,
      top: Math.min(...points.map((p) => p.y)) - size / 2 + offsetY,
      bottom: Math.max(...points.map((p) => p.y)) + size / 2 + offsetY,
    };
  };
  const eye = boxOf(1);
  const share = gaze ? 1 : SLEEP_GAZE_MAX;
  return {
    leftEye: boxOf(0),
    rightEye: eye,
    mouth: boxOf(2),
    gazeX: share * GAZE_EYE_RANGE_X * frame,
    gazeY: share * GAZE_EYE_RANGE_Y * frame + (gaze ? 0 : (eye.bottom - eye.top) * SLEEP_LID_FLICKER),
  };
}

const face = sleepingFace();
const layout = layoutSleepZs(face, FRAME);
const cycle = (each: (t: number) => void) => {
  for (let t = 0; t < 3.6; t += 0.05) each(t);
};
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Everywhere a part of the face can be: its box widened by the gaze range. */
const reachOf = (box: Box, f: SleepingFace): Box => ({ left: box.left - f.gazeX, right: box.right + f.gazeX, top: box.top - f.gazeY, bottom: box.bottom + f.gazeY });

describe('sleeping Zs in a studio frame', () => {
  it('never cover the eyes or the mouth, as they drift and twitch in their sleep', () => {
    const parts = [face.leftEye, face.rightEye, face.mouth].map((part) => reachOf(part, face));
    cycle((t) => {
      for (const z of sleepZs(t, layout)) {
        for (const part of parts) expect(overlaps(letterBox(z), part), `t=${t.toFixed(2)}`).toBe(false);
      }
    });
  });

  // For a face whose eyes could still move, the layout keeps clear of wherever they could go.
  it('keep clear of the whole gaze range of eyes that can move', () => {
    const moving = sleepingFace(FRAME, 0, true);
    const zs = layoutSleepZs(moving, FRAME);
    const parts = [moving.leftEye, moving.rightEye, moving.mouth].map((part) => reachOf(part, moving));
    cycle((t) => {
      for (const z of sleepZs(t, zs)) {
        for (const part of parts) expect(overlaps(letterBox(z), part)).toBe(false);
      }
    });
  });

  it('stay inside the frame through the whole float, glow included', () => {
    cycle((t) => {
      for (const z of sleepZs(t, layout)) {
        const box = letterBox(z);
        const halo = glowReach(z);
        expect(box.left - halo, `t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(0);
        expect(box.right + halo, `t=${t.toFixed(2)}`).toBeLessThanOrEqual(FRAME);
        expect(box.top - halo, `t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(0);
        expect(box.bottom + halo, `t=${t.toFixed(2)}`).toBeLessThanOrEqual(FRAME);
      }
    });
  });

  // Far back in a window the face is small; the Zs have to still read there.
  it('are big: the largest about 15 % of the frame height', () => {
    const largest = DEFAULT_GLYPH.heightEm * layout.em;
    expect(largest / FRAME).toBeGreaterThanOrEqual(0.14);
    expect(largest / FRAME).toBeLessThanOrEqual(0.16);
  });

  it('start just above the right eye\'s outer corner and float up and to the right', () => {
    const [first] = sleepZs(0, layout);
    expect(Math.abs(first!.cx - face.rightEye.right)).toBeLessThan(FRAME * 0.08);
    expect(letterBox(first!).bottom).toBeLessThan(face.rightEye.top - face.gazeY);
    const later = sleepZs(1.8, layout)[0]!;
    expect(later.cy).toBeLessThan(first!.cy);
    expect(later.cx).toBeGreaterThan(first!.cx);
  });

  it('get smaller and higher, one after the other, like z z z', () => {
    const zs = sleepZs(0, layout);
    expect(zs.map((z) => z.fontPx / zs[0]!.fontPx)).toEqual([1, 0.7, 0.48].map((ratio) => expect.closeTo(ratio, 5)));
    expect(zs[1]!.cy).toBeLessThan(zs[0]!.cy);
    expect(zs[2]!.cy).toBeLessThan(zs[1]!.cy);
  });

  // Main and Small are laid out from their own faces, not one fixed offset.
  it('follow the face they belong to', () => {
    const higherFace = sleepingFace(FRAME, -120);
    const higher = layoutSleepZs(higherFace, FRAME);
    expect(higher.y).toBeLessThan(layout.y);
    for (const z of sleepZs(0, higher)) {
      expect(overlaps(letterBox(z), reachOf(higherFace.rightEye, higherFace))).toBe(false);
      expect(letterBox(z).top - glowReach(z)).toBeGreaterThanOrEqual(0);
    }
  });

  // The app's zzzFloat: 3.6 s, each Z 1.2 s after the last; fades in to 0.92,
  // drifts up and right while growing from 0.82 to 1.08, and fades out.
  it('float and fade as the face window\'s zzzFloat does', () => {
    const at = (t: number) => sleepZs(t, layout)[0]!;
    expect(at(0)).toMatchObject({ opacity: 0, scale: 0.82 });
    expect(at(0.12 * 3.6).opacity).toBeCloseTo(0.92, 3);
    expect(at(0.75 * 3.6).opacity).toBeCloseTo(0.7, 3);
    expect(at(3.6 - 1e-6).opacity).toBeCloseTo(0, 3);
    expect(at(3.6 - 1e-6).scale).toBeCloseTo(1.08, 3);
    expect(sleepZs(0, layout)[1]!.opacity).toBeCloseTo(sleepZs(1.2, layout)[0]!.opacity, 6);
    expect(at(1)).toEqual(at(4.6));
  });

  it('stand still and visible with reduced motion, as the app does', () => {
    expect(sleepZs(2, layout, true).map((z) => [z.opacity, z.scale])).toEqual([[0.8, 1], [0.8, 1], [0.8, 1]]);
  });

  it('use CSS ease-in-out', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 4);
    expect(easeInOut(0.25)).toBeCloseTo(0.1291, 3);
  });
});

// The Zs must read the same on both heads, over any backdrop: one bright
// near-white for the letters; only a faint glow in the head's colour tells the
// heads apart.
describe('sleeping Zs colour', () => {
  function drawn(headColour: string | null): { letters: string[]; glows: string[] } {
    const letters: string[] = [];
    const glows: string[] = [];
    const ctx = {
      shadowColor: 'transparent',
      shadowBlur: 0,
      fillStyle: '',
      font: '',
      globalAlpha: 1,
      textAlign: 'start',
      textBaseline: 'alphabetic',
      save() {},
      restore() {},
      translate() {},
      scale() {},
      measureText: () => ({ actualBoundingBoxLeft: 0, actualBoundingBoxRight: 50, actualBoundingBoxAscent: 52, actualBoundingBoxDescent: 0 }),
      fillText() {
        if (this.shadowBlur > 0) glows.push(this.shadowColor);
        else letters.push(this.fillStyle);
      },
    };
    drawSleepZs(ctx as unknown as CanvasRenderingContext2D, 1, layout, { headColour });
    return { letters, glows };
  }

  it('draws the letters in the one studio colour for both heads', () => {
    for (const head of ['#a855f7', '#22d3ee']) {
      const { letters } = drawn(head);
      expect(letters.length).toBe(3);
      expect(new Set(letters)).toEqual(new Set([STUDIO_ZZZ_COLOR]));
    }
    expect(STUDIO_ZZZ_COLOR).toBe('#f1eefc');
  });

  it('tints only the faint outer glow with the head\'s colour', () => {
    expect(drawn('#a855f7').glows).toContain('rgba(168, 85, 247, 0.55)');
    expect(drawn('#22d3ee').glows).toContain('rgba(34, 211, 238, 0.55)');
    expect(drawn('#a855f7').glows).toContain(withAlpha(STUDIO_ZZZ_COLOR, 0.95));
  });
});
