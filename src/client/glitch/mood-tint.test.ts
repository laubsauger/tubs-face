import { describe, expect, it } from 'vitest';
import { moodTint } from './mood-tint.js';

// The face should show Tubs's mood from across the room, and leave the
// operator's colour alone when he is just being his usual smug self.

const RESTING = { pos: 0.24, neg: 0.06, arousal: 0.2 };
const IRRITATED = { pos: 0.2, neg: 0.45, arousal: 0.7 };
const SULKING = { pos: 0.15, neg: 0.5, arousal: 0.2 };
const DELIGHTED = { pos: 0.7, neg: 0.03, arousal: 0.65 };
const SMUG = { pos: 0.4, neg: 0.13, arousal: 0.38 };

describe('moodTint', () => {
  it('leaves the face as configured at rest and when merely smug', () => {
    for (const mood of [RESTING, SMUG]) {
      const tint = moodTint(mood);
      expect(Math.abs(tint.hueShift)).toBeLessThan(8);
      expect(tint.burstInterval).toBeCloseTo(1, 1);
    }
  });

  it('pushes an irritated face toward red with more glitching', () => {
    const tint = moodTint(IRRITATED);
    expect(tint.hueShift).toBeGreaterThan(50);
    expect(tint.burstInterval).toBeLessThan(0.6);
    expect(tint.chroma).toBeGreaterThan(2);
  });

  it('cools and washes out a sulking face, warms and brightens a delighted one', () => {
    const sulk = moodTint(SULKING);
    expect(sulk.hueShift).toBeLessThan(-25);
    expect(sulk.saturation).toBeLessThan(0.7);
    const joy = moodTint(DELIGHTED);
    expect(joy.hueShift).toBeGreaterThan(15);
    expect(joy.lightness).toBeGreaterThan(3);
  });

  it('stays within caps at the extremes', () => {
    const tint = moodTint({ pos: 0, neg: 1, arousal: 1 });
    expect(tint.hueShift).toBeLessThanOrEqual(70);
    expect(tint.burstInterval).toBeGreaterThanOrEqual(0.4);
  });
});
