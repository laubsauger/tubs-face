import { describe, expect, it } from 'vitest';
import type { EnrolledFace } from '../../shared/contracts/faces.js';
import { FOLD_OVER_SAMPLES, SESSION_GAP_MS, groupLibrary } from './library-sessions.js';

// The library dialog listed every sample on its own line, so an onboarding's
// five poses looked like five unrelated photos. A person is one block; the
// samples taken in one sitting (minutes apart at most) are one row. The
// library stores no session, so the rule is the time between samples.

const sample = (id: string, name: string, createdAt?: number): EnrolledFace => ({ id, name, embedding: [0.1], ...(createdAt !== undefined ? { createdAt } : {}) });
const MIN = 60_000;

describe('groupLibrary', () => {
  it('puts samples a few seconds apart in one session, and a later sitting in another', () => {
    const day1 = 1_000_000;
    const day2 = day1 + 24 * 60 * MIN;
    const people = groupLibrary([
      sample('a', 'Flo', day1), sample('b', 'flo', day1 + 4_000), sample('c', 'Flo ', day1 + 9_000),
      sample('d', 'Flo', day2), sample('e', 'Flo', day2 + 3_000),
      sample('f', 'Dimi', day1),
    ]);
    expect(people.map((person) => [person.name, person.samples])).toEqual([['Dimi', 1], ['Flo', 5]]);
    const flo = people[1]!;
    // Newest sitting first.
    expect(flo.sessions.map((session) => session.faces.map((face) => face.id))).toEqual([['d', 'e'], ['a', 'b', 'c']]);
    expect(flo.lastSampleAt).toBe(day2 + 3_000);
  });

  it('splits at the gap, chains within it, and keeps samples without a time apart', () => {
    const t = 5_000_000;
    const people = groupLibrary([
      sample('a', 'Rosa', t), sample('b', 'Rosa', t + SESSION_GAP_MS - 1), sample('c', 'Rosa', t + 2 * SESSION_GAP_MS - 2),
      sample('d', 'Rosa', t + 3 * SESSION_GAP_MS + 10),
      sample('e', 'Rosa'),
    ]);
    // a, b and c chain (each under the gap from the one before); d is a new sitting; e has no time.
    expect(people[0]!.sessions.map((session) => [session.startedAt, session.faces.map((face) => face.id)])).toEqual([
      [t + 3 * SESSION_GAP_MS + 10, ['d']],
      [t, ['a', 'b', 'c']],
      [null, ['e']],
    ]);
  });

  it('folds people with many samples', () => {
    const many = Array.from({ length: FOLD_OVER_SAMPLES + 1 }, (_, index) => sample(`s${index}`, 'Flo', index * 1000));
    expect(groupLibrary(many)[0]!.foldedByDefault).toBe(true);
    expect(groupLibrary(many.slice(0, FOLD_OVER_SAMPLES))[0]!.foldedByDefault).toBe(false);
  });
});
