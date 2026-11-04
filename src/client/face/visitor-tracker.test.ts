import { describe, expect, it } from 'vitest';
import type { DetectedFace } from '../../shared/contracts/faces.js';
import { CALL_BACK_CHANCE, FORGET_AFTER_MS, createVisitorTracker, type VisitorEvent } from './visitor-tracker.js';

// Who is in front of Tubs decides what he remembers. Forgetting a visitor who
// only stepped aside breaks the conversation; keeping one after a stranger
// walks up makes Tubs talk to the wrong person about the wrong jacket.

const ANNA = [1, 0, 0];
const ANNA_TURNED = [0.85, 0.3, 0.1];
const STRANGER = [0, 1, 0];
const face = (embedding: number[] | null, name?: string): DetectedFace => ({ box: [0, 0, 10, 10], score: 1, embedding, ...(name ? { name } : {}) });
const types = (events: VisitorEvent[]) => events.map((event) => event.type);

/** Feeds a detection every 500 ms from `from` to `to` (inclusive) and collects events. */
function run(tracker: ReturnType<typeof createVisitorTracker>, from: number, to: number, faces: DetectedFace[], talking = false): VisitorEvent[] {
  const events: VisitorEvent[] = [];
  for (let t = from; t <= to; t += 500) events.push(...tracker.update(faces, t, talking));
  return events;
}

describe('visitor tracker', () => {
  it('keeps a visitor who stepped out of view, and only forgets after minutes', () => {
    const tracker = createVisitorTracker(() => 0.99);
    expect(types(run(tracker, 0, 1000, [face(ANNA)]))).toEqual(['arrived']);
    expect(types(run(tracker, 1500, 90_000, []))).toEqual([]);
    const back = run(tracker, 90_500, 90_500, [face(ANNA_TURNED)]);
    expect(back).toEqual([{ type: 'returned', names: [], awayMs: 89_000 }]);

    expect(types(run(tracker, 91_000, 91_000 + FORGET_AFTER_MS, []))).toEqual(['gone']);
  });

  it('starts fresh at once when someone else comes into view after the visitor left', () => {
    const tracker = createVisitorTracker(() => 0.99);
    run(tracker, 0, 1000, [face(ANNA)]);
    run(tracker, 1500, 10_000, []);
    expect(types(run(tracker, 10_500, 10_500, [face(STRANGER)]))).toEqual(['new_visitor']);
  });

  it('a stranger who replaces the visitor without a gap counts after a few seconds', () => {
    const tracker = createVisitorTracker(() => 0.99);
    run(tracker, 0, 1000, [face(ANNA)]);
    expect(types(run(tracker, 1500, 3500, [face(STRANGER)]))).toEqual([]);
    expect(types(run(tracker, 4000, 5000, [face(STRANGER)]))).toEqual(['new_visitor']);
  });

  it('recognises an enrolled visitor by name even when the embedding is off', () => {
    const tracker = createVisitorTracker(() => 0.99);
    run(tracker, 0, 1000, [face(ANNA, 'Anna')]);
    run(tracker, 1500, 30_000, []);
    expect(types(run(tracker, 30_500, 30_500, [face(STRANGER, 'Anna')]))).toEqual(['returned']);
  });

  it('cannot tell without embeddings, so it keeps the visitor', () => {
    const tracker = createVisitorTracker(() => 0.99);
    run(tracker, 0, 1000, [face(null)]);
    run(tracker, 1500, 30_000, []);
    expect(types(run(tracker, 30_500, 30_500, [face(STRANGER)]))).toEqual(['returned']);
  });

  it('calls a named visitor back on some departures mid-conversation, once per visit', () => {
    const lucky = createVisitorTracker(() => CALL_BACK_CHANCE - 0.01);
    run(lucky, 0, 1000, [face(ANNA, 'Anna')], true);
    const away = run(lucky, 1500, 30_000, [], true);
    expect(away).toEqual([{ type: 'call_back', name: 'Anna' }]);
    run(lucky, 30_500, 31_000, [face(ANNA, 'Anna')], true);
    expect(types(run(lucky, 31_500, 60_000, [], true))).toEqual([]);
  });

  it('does not call back strangers, visitors who were not talking, or on unlucky rolls', () => {
    const cases: Array<[() => number, string | undefined, boolean]> = [
      [() => 0, undefined, true],
      [() => 0, 'Anna', false],
      [() => CALL_BACK_CHANCE + 0.01, 'Anna', true],
    ];
    for (const [random, name, talking] of cases) {
      const tracker = createVisitorTracker(random);
      run(tracker, 0, 1000, [face(ANNA, name)], talking);
      expect(types(run(tracker, 1500, 60_000, [], talking))).toEqual([]);
    }
  });
});
