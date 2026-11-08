import { describe, expect, it } from 'vitest';
import { RENDER_PAUSE_MAX_MS, faceChecksPaused } from './render-pause.js';

// Ming comes first: no face check while a voice renders. But a lost "render
// stopped" message must not leave Tubs blind to faces.
describe('faceChecksPaused', () => {
  it('waits while a voice renders', () => {
    expect(faceChecksPaused(1_000, 1_500)).toBe(true);
  });

  it('runs when nothing renders', () => {
    expect(faceChecksPaused(null, 1_500)).toBe(false);
  });

  it('stops waiting on a render that never reported its end', () => {
    expect(faceChecksPaused(1_000, 1_000 + RENDER_PAUSE_MAX_MS + 1)).toBe(false);
  });
});
