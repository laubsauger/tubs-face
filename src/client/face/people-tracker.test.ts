import { describe, expect, it } from 'vitest';
import type { DetectedFace } from '../../shared/contracts/faces.js';
import { createPeopleTracker } from './people-tracker.js';

// Notes and the roast mirror need to know which person is which in a group,
// and where they stand, frame after frame.

const ANNA = [1, 0, 0];
const BEN = [0, 1, 0];
const CARL = [0, 0, 1];
const at = (embedding: number[] | null, x: number, name?: string): DetectedFace => ({ box: [x - 10, 0, x + 10, 20], score: 1, embedding, ...(name ? { name } : {}) });

describe('people tracker', () => {
  it('keeps each person their id as they move around, and reports them left to right', () => {
    const tracker = createPeopleTracker(() => 0.5);
    const first = tracker.update([at(ANNA, 100), at(BEN, 500)], 600, 0);
    expect(first.map((p) => p.position)).toEqual(['left', 'right']);
    // They swap places.
    const swapped = tracker.update([at(BEN, 80), at(ANNA, 520)], 600, 500);
    expect(swapped.map((p) => p.id)).toEqual([first[1]!.id, first[0]!.id]);
  });

  it('gives a newcomer joining the group a new id without touching the others', () => {
    const tracker = createPeopleTracker(() => 0.5);
    const [anna] = tracker.update([at(ANNA, 300)], 600, 0);
    const group = tracker.update([at(ANNA, 100), at(CARL, 500)], 600, 500);
    expect(group[0]!.id).toBe(anna!.id);
    expect(group[1]!.id).not.toBe(anna!.id);
  });

  it('recognises someone back hours later and says how long they were gone', () => {
    const tracker = createPeopleTracker(() => 0.5);
    const [anna] = tracker.update([at(ANNA, 300)], 600, 0);
    tracker.update([], 600, 10_000);
    const [back] = tracker.update([at(ANNA, 300)], 600, 2 * 3600_000);
    expect(back).toMatchObject({ id: anna!.id });
    expect(back!.awayMs).toBeGreaterThan(3600_000);
    // Only on the frame they came back.
    expect(tracker.update([at(ANNA, 300)], 600, 2 * 3600_000 + 500)[0]!.awayMs).toBeUndefined();
  });

  it('keeps a face that briefly disappears in the group', () => {
    const tracker = createPeopleTracker(() => 0.5);
    const [anna] = tracker.update([at(ANNA, 300)], 600, 0);
    tracker.update([], 600, 1000);
    expect(tracker.update([at(ANNA, 300)], 600, 3000)[0]).toMatchObject({ id: anna!.id, names: [], position: 'center' });
  });

  it('matches enrolled names even when the embedding is off', () => {
    const tracker = createPeopleTracker(() => 0.5);
    const [anna] = tracker.update([at(ANNA, 300, 'Anna')], 600, 0);
    expect(tracker.update([at(BEN, 300, 'Anna')], 600, 500)[0]!.id).toBe(anna!.id);
  });

  // Recognition drops in and out (head down, side-on, bad light). A face that
  // stays where someone just was is still them, or Tubs greets them again.
  it('keeps the id while recognition misses, as long as the face stays put', () => {
    const tracker = createPeopleTracker(() => 0.5);
    const [anna] = tracker.update([at(ANNA, 300, 'Anna')], 600, 0);
    expect(anna!.joined).toBe(true);
    // Same spot, no name, an embedding that matches nobody.
    const [still] = tracker.update([at(BEN, 304)], 600, 500);
    expect(still!.id).toBe(anna!.id);
    expect(still!.joined).toBeUndefined();
    expect(still!.names).toEqual(['Anna']);
    // A poor embedding somewhere else is someone else.
    const both = tracker.update([at(ANNA, 300, 'Anna'), at(CARL, 520)], 600, 1000);
    expect(both[1]!.id).not.toBe(anna!.id);
    expect(both[1]!.joined).toBe(true);
  });
});
