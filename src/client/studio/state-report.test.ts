import { describe, expect, it } from 'vitest';
import type { ExpressionName } from '../../shared/contracts/config.js';
import { studioStateChanged, studioStateOf, type StudioStateSnapshot } from './state-report.js';

const base = { audioPlaying: false, sleeping: false, currentExpression: 'idle' as ExpressionName, moodPos: 0.24, moodNeg: 0.06, moodArousal: 0.2 };

// The director routes the voice and drives the scene from studio_state, so
// speech starting and a new face must reach it at once. The mood eases every
// frame; reporting each step would flood every client at 60 Hz.
describe('studio_state', () => {
  const at = (overrides: Partial<typeof base>): StudioStateSnapshot => studioStateOf({ ...base, ...overrides });

  it('goes out at once when a head starts or stops speaking, or changes face', () => {
    expect(studioStateChanged(at({}), at({ audioPlaying: true }))).toBe(true);
    expect(studioStateChanged(at({ audioPlaying: true }), at({}))).toBe(true);
    expect(studioStateChanged(at({}), at({ currentExpression: 'happy' }))).toBe(true);
  });

  it('leaves small mood drift to the heartbeat, but not a visible change', () => {
    expect(studioStateChanged(at({}), at({ moodPos: 0.27 }))).toBe(false);
    expect(studioStateChanged(at({}), at({ moodNeg: 0.4 }))).toBe(true);
  });

  it('says sleep while asleep, whatever face is set underneath', () => {
    expect(at({ sleeping: true, currentExpression: 'idle' }).expr).toBe('sleep');
  });

  it('always sends the first one', () => {
    expect(studioStateChanged(null, at({}))).toBe(true);
  });
});
