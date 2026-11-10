import { describe, expect, it } from 'vitest';
import type { DetectedFace, FaceBox } from '../../shared/contracts/faces.js';
import { acceptedMatch } from './matching.js';
import { GREETING_NAME_WAIT_MS, createGreetingHold, createNameSettler } from './settle.js';

// Live, 2026-11-09: Flo (59 samples) in front of the camera, one check every
// ~5 s: "match Rapha [Rapha 0.715, Flo 0.678, Anderson 0.644]", then "unknown
// [Flo 0.52, ...]" twice. That one frame named him Rapha, Tubs greeted "Rapha"
// and tonight's notes went to Rapha. A name must come from a track that matched
// the same person on several checks, clearly ahead of the next person, and must
// not flip on one frame.

/** One check of a face as annotateDetectedFaces leaves it: its best sample per person, and this frame's verdict. */
function face(similarities: Record<string, number>, options: { box?: FaceBox; trackedAge?: number } = {}): DetectedFace {
  const matches = Object.entries(similarities).map(([name, score]) => ({ id: name, name, score })).sort((a, b) => b.score - a.score).slice(0, 3);
  const accepted = acceptedMatch(matches);
  return {
    box: options.box ?? [100, 100, 200, 220],
    score: 0.9,
    embedding: [1],
    name: accepted?.name ?? null,
    match: accepted,
    matches,
    ...(options.trackedAge !== undefined ? { _trackedAge: options.trackedAge } : {}),
  };
}

function checker() {
  const settler = createNameSettler();
  let now = 1_000_000;
  return {
    settler,
    /** One check of one face; the name it shows. */
    check(similarities: Record<string, number>, options: { box?: FaceBox; trackedAge?: number } = {}) {
      now += 5000;
      const [settled] = settler.settle([face(similarities, options)], now);
      return settled!;
    },
  };
}

describe('names settled per track', () => {
  it('replays the live frames: the one close frame never names Flo "Rapha"', () => {
    // The frame itself would have, with the old margin of 0.01.
    expect(acceptedMatch([{ name: 'Rapha', score: 0.715 }, { name: 'Flo', score: 0.678 }], 0.01)?.name).toBe('Rapha');
    const { check } = checker();
    const shown = [
      check({ Rapha: 0.715, Flo: 0.678, Anderson: 0.644 }),
      check({ Flo: 0.52, Tihana: 0.117, Denali: 0.115 }),
      check({ Flo: 0.52, Tihana: 0.117, Denali: 0.115 }),
    ].map((result) => result.name);
    expect(shown).toEqual([null, null, null]);
  });

  it('leaves a face unknown while the runner-up is within the margin, however often it comes', () => {
    const { check } = checker();
    for (let i = 0; i < 6; i += 1) expect(check({ Flo: 0.8, Rapha: 0.72 }).name).toBeNull();
  });

  it('settles a consistent match within two checks', () => {
    const { check } = checker();
    const first = check({ Flo: 0.7, Rapha: 0.4 });
    expect(first.name).toBeNull();
    expect(first.pending).toBe('Flo');
    expect(check({ Flo: 0.71, Rapha: 0.38 })).toMatchObject({ name: 'Flo', match: { name: 'Flo', score: 0.71 } });
  });

  it('names at once only on one very clear check', () => {
    const { check } = checker();
    expect(check({ Flo: 0.86, Rapha: 0.3 }).name).toBe('Flo');
  });

  it('does not rename a settled track on one frame, however clear', () => {
    const { check } = checker();
    check({ Flo: 0.72, Rapha: 0.3 });
    expect(check({ Flo: 0.74, Rapha: 0.3 }).name).toBe('Flo');
    // One frame (a turned head, bad light) clearly says Rapha: still Flo.
    expect(check({ Rapha: 0.85, Flo: 0.5 }).name).toBe('Flo');
    expect(check({ Flo: 0.73, Rapha: 0.31 }).name).toBe('Flo');
  });

  it('keeps a settled name through checks that name nobody', () => {
    const { check } = checker();
    check({ Flo: 0.72, Rapha: 0.3 });
    check({ Flo: 0.74, Rapha: 0.3 });
    for (let i = 0; i < 5; i += 1) expect(check({ Flo: 0.52, Tihana: 0.12 }).name).toBe('Flo');
  });

  it('renames only when another person matches as often as a name needs to settle', () => {
    const { check } = checker();
    check({ Flo: 0.72, Rapha: 0.3 });
    check({ Flo: 0.74, Rapha: 0.3 });
    expect(check({ Rapha: 0.8, Flo: 0.4 }).name).toBe('Flo');
    expect(check({ Rapha: 0.81, Flo: 0.41 }).name).toBe('Rapha');
  });

  it('counts a reused embedding once, not as a second check', () => {
    const { check } = checker();
    check({ Flo: 0.7, Rapha: 0.4 }, { trackedAge: 0 });
    // The worker kept the tracked face's embedding: same evidence again.
    expect(check({ Flo: 0.7, Rapha: 0.4 }, { trackedAge: 1 }).name).toBeNull();
    expect(check({ Flo: 0.7, Rapha: 0.4 }, { trackedAge: 2 }).name).toBeNull();
    // Without a tracked age, the very same scores are taken as the same embedding.
    expect(check({ Flo: 0.7, Rapha: 0.4 }).name).toBeNull();
    expect(check({ Flo: 0.69, Rapha: 0.41 }, { trackedAge: 0 }).name).toBe('Flo');
  });

  it('follows each face by where it is, and forgets names when the library changes', () => {
    const settler = createNameSettler();
    const left: FaceBox = [50, 100, 150, 220];
    const right: FaceBox = [600, 100, 700, 220];
    const frame = (now: number, a: Record<string, number>, b: Record<string, number>) =>
      settler.settle([face(a, { box: left }), face(b, { box: right })], now).map((result) => result.name);
    frame(1000, { Flo: 0.72, Rapha: 0.2 }, { Rapha: 0.75, Flo: 0.2 });
    expect(frame(2000, { Flo: 0.73, Rapha: 0.2 }, { Rapha: 0.74, Flo: 0.2 })).toEqual(['Flo', 'Rapha']);
    settler.reset();
    expect(frame(3000, { Flo: 0.72, Rapha: 0.21 }, { Rapha: 0.73, Flo: 0.2 })).toEqual([null, null]);
  });
});

// A known face's first check only starts its name (a vote, not settled), and
// the arrival greeting used to go out on that check: Tubs greeted someone he
// knows as a stranger. The greeting waits for the name, briefly, as the face
// service's does (server/faces/recognition.ts).
describe('the arrival greeting', () => {
  it('waits for a name on its way, then goes with the greeting it was started with', () => {
    const hold = createGreetingHold<{ returning: boolean }>();
    expect(hold.next({ faces: 1, trigger: true, greeting: { returning: false }, nameOnItsWay: true, now: 0 })).toEqual({ send: false, holding: true, greeting: null });
    expect(hold.next({ faces: 1, trigger: false, greeting: null, nameOnItsWay: true, now: 1000 })).toMatchObject({ send: false, holding: true });
    expect(hold.next({ faces: 1, trigger: false, greeting: null, nameOnItsWay: false, now: 1500 })).toEqual({ send: true, holding: false, greeting: { returning: false } });
    // Sent once.
    expect(hold.next({ faces: 1, trigger: false, greeting: null, nameOnItsWay: false, now: 2000 }).send).toBe(false);
  });

  it('goes without the name after the wait, at once when no name is on its way, and not at all once nobody is in view', () => {
    const hold = createGreetingHold<{ returning: boolean }>();
    hold.next({ faces: 1, trigger: true, greeting: { returning: true }, nameOnItsWay: true, now: 0 });
    expect(hold.next({ faces: 1, trigger: false, greeting: null, nameOnItsWay: true, now: GREETING_NAME_WAIT_MS })).toEqual({ send: true, holding: false, greeting: { returning: true } });
    expect(hold.next({ faces: 1, trigger: true, greeting: { returning: false }, nameOnItsWay: false, now: 10_000 })).toEqual({ send: true, holding: false, greeting: { returning: false } });
    hold.next({ faces: 1, trigger: true, greeting: { returning: false }, nameOnItsWay: true, now: 20_000 });
    expect(hold.next({ faces: 0, trigger: false, greeting: null, nameOnItsWay: false, now: 20_500 }).send).toBe(false);
    expect(hold.next({ faces: 1, trigger: false, greeting: null, nameOnItsWay: false, now: 21_000 }).send).toBe(false);
  });
});
