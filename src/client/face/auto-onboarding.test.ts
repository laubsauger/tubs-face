import { describe, expect, it } from 'vitest';
import type { DetectedFace } from '../../shared/contracts/faces.js';
import { AUTO_ENROLL_SNAPSHOTS, type Snapshot, wantsSnapshot } from './auto-onboarding.js';

// Snapshots become someone's face in the library the moment they say their
// name, so only good, varied ones of people Tubs does not know yet count.

const face = (embedding: number[] | null, height = 200): DetectedFace => ({ box: [100, 100, 260, 100 + height], score: 1, embedding });
const snap = (embedding: number[], at: number): Snapshot => ({ embedding, thumbnail: 'data:image/jpeg;base64,', at });

describe('wantsSnapshot', () => {
  it('takes a big, clear face of someone unnamed', () => {
    expect(wantsSnapshot({ names: [], face: face([1, 0, 0]) }, [], 0, 720)).toBe(true);
  });

  it('skips people already known, tiny faces and faces without an embedding', () => {
    expect(wantsSnapshot({ names: ['Anna'], face: face([1, 0, 0]) }, [], 0, 720)).toBe(false);
    expect(wantsSnapshot({ names: [], face: face([1, 0, 0], 60) }, [], 0, 720)).toBe(false);
    expect(wantsSnapshot({ names: [], face: face(null) }, [], 0, 720)).toBe(false);
  });

  it('spaces snapshots out, stops at three and skips near-duplicates', () => {
    const one = [snap([1, 0, 0], 0)];
    expect(wantsSnapshot({ names: [], face: face([0, 1, 0]) }, one, 2000, 720)).toBe(false);
    expect(wantsSnapshot({ names: [], face: face([0, 1, 0]) }, one, 5000, 720)).toBe(true);
    expect(wantsSnapshot({ names: [], face: face([0.999, 0.01, 0]) }, one, 5000, 720)).toBe(false);
    const full = Array.from({ length: AUTO_ENROLL_SNAPSHOTS }, (_, i) => snap([i, 1, 0], i * 5000));
    expect(wantsSnapshot({ names: [], face: face([0, 0, 1]) }, full, 60_000, 720)).toBe(false);
  });
});
