import { describe, expect, it } from 'vitest';
import { BLACK_CHECKS, createBlackFrameMonitor } from './black-frame.js';

// GET /studio said both heads were publishing while their streams were black.
// The page has to notice its own frame going black and stop claiming it.
describe('black published frame', () => {
  it('is called out once the frame stays black', () => {
    const monitor = createBlackFrameMonitor();
    const results = Array.from({ length: BLACK_CHECKS }, () => monitor.check(0));
    expect(results.at(-1)).toBe(true);
    expect(results.slice(0, -1).every((black) => !black)).toBe(true);
  });

  it('ignores a single dark frame', () => {
    const monitor = createBlackFrameMonitor();
    expect([monitor.check(0), monitor.check(200), monitor.check(0)]).toEqual([false, false, false]);
  });

  it('clears as soon as the face is back', () => {
    const monitor = createBlackFrameMonitor();
    for (let i = 0; i < BLACK_CHECKS; i += 1) monitor.check(3);
    expect(monitor.check(180)).toBe(false);
  });
});
