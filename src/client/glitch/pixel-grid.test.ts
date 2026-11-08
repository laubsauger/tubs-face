import { describe, expect, it } from 'vitest';
import type { AppState } from '../state/app-state.js';
import { DEFAULT_CONFIG, GAZE_EYE_RANGE_X, GAZE_EYE_RANGE_Y } from './constants.js';
import { SCREEN_LAYOUT, STUDIO_LAYOUT, buildPixelGrid } from './pixel-grid.js';

// A studio stream is placed by its centre: the director's entity position is
// the centre of the face, and window renderers draw the frame centred there.
// A face sitting high in the frame (as on a screen, to clear the listening
// dot) would float above where the director put it.

const FRAME = 1024;
const SIZE = 8;
const GAP = 3;
// Pixels sit on a grid, so the drawn face can only be centred to within one pitch.
const PITCH = SIZE + GAP;

function bounds(layout: typeof STUDIO_LAYOUT) {
  const state = { sleeping: false, currentExpression: 'idle' } as AppState;
  const { pixelGrid } = buildPixelGrid(state, DEFAULT_CONFIG, FRAME, FRAME, SIZE, GAP, layout);
  const xs = pixelGrid.map((p) => p.x);
  const ys = pixelGrid.map((p) => p.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

describe('studio face layout', () => {
  it('centres the face in the square frame', () => {
    const { left, right, top, bottom } = bounds(STUDIO_LAYOUT);
    expect(Math.abs((left + right) / 2 - FRAME / 2)).toBeLessThanOrEqual(PITCH);
    expect(Math.abs((top + bottom) / 2 - FRAME / 2)).toBeLessThanOrEqual(PITCH);
  });

  // Window renderers show the whole frame and nothing outside it: an eye that
  // looks hard left or right must not be cut off at the frame's edge.
  it('keeps the eyes inside the frame when they look all the way to a side, up or down', () => {
    const { left, right, top, bottom } = bounds(STUDIO_LAYOUT);
    const sideways = GAZE_EYE_RANGE_X * FRAME;
    const upDown = GAZE_EYE_RANGE_Y * FRAME;
    expect(left - sideways - PITCH).toBeGreaterThan(0);
    expect(right + sideways + PITCH).toBeLessThan(FRAME);
    expect(top - upDown - PITCH).toBeGreaterThan(0);
    expect(bottom + upDown + PITCH).toBeLessThan(FRAME);
  });

  it('is still as large as that allows (over 60 % of the width at rest)', () => {
    const { left, right } = bounds(STUDIO_LAYOUT);
    expect(right - left).toBeGreaterThan(FRAME * 0.6);
  });

  it('leaves the screen layout as it was (above centre)', () => {
    const { top, bottom } = bounds(SCREEN_LAYOUT);
    expect((top + bottom) / 2).toBeLessThan(FRAME / 2 - 10);
  });
});
