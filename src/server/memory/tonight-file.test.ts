import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTonight, forgetPeople, memoryContext, NOTES_TTL_MS, onTonightChange, recordFieldNotes, resetFieldNotes, setPeople, tonightsPeople } from '../assistant/field-notes.js';
import { buildMemory } from './view.js';
import { flushTonight, restoreTonight, TONIGHT_WRITE_DELAY_MS } from './tonight-file.js';

// The server was restarted five times on 9 Nov for deploys, and every time
// tonight's notes, quotes and who had been seen were gone: the memory view
// showed nobody, and Tubs met everyone again as strangers.

const flo = { id: 's1-p1', names: ['Flo'], position: 'center' as const };
const stranger = { id: 's1-p2', names: [], position: 'center' as const, snapshots: 1, thumbnail: 'data:image/jpeg;base64,AAAA' };
let dir = '';
const file = () => path.join(dir, 'tonight.json');
const saved = () => JSON.parse(readFileSync(file(), 'utf8')) as { people: Array<{ id: string; notes: string[] }>; quotes: unknown[] };

/** What a restart does to the memory: gone from the process, back from the file. */
function restart(now: number): number {
  resetFieldNotes();
  onTonightChange(null);
  return restoreTonight(now);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-tonight-'));
  process.env.TUBS_TONIGHT_FILE = file();
  resetFieldNotes();
  onTonightChange(null);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TUBS_TONIGHT_FILE;
  onTonightChange(null);
});

describe('tonight across a restart', () => {
  it('brings back the notes, quotes, snapshots and who was seen, and the person under their new id', () => {
    const t0 = Date.now();
    restoreTonight(t0);
    setPeople([flo], t0);
    recordFieldNotes('[[NOTE: builds robots]] [[QUOTE: robots need hats]]', t0 + 1);
    setPeople([stranger], t0 + 2);
    recordFieldNotes('[[NOTE: bakes bread at night]]', t0 + 3);
    flushTonight(t0 + 4);

    expect(restart(t0 + 60_000)).toBe(2);
    const people = tonightsPeople(t0 + 60_000).people;
    expect(people.find((person) => person.id === 's1-p1')).toMatchObject({ names: ['Flo'], notes: ['builds robots'], quotes: ['robots need hats'] });
    expect(people.find((person) => person.id === 's1-p2')).toMatchObject({ notes: ['bakes bread at night'], thumbnail: 'data:image/jpeg;base64,AAAA' });

    // The memory view shows them, Flo on Flo's card.
    const memory = buildMemory({ ...tonightsPeople(t0 + 60_000), faces: [], relationships: [], relationshipsEnabled: true });
    expect(memory.cards.find((card) => card.key === 'name:flo')).toMatchObject({ seenTonight: true, notes: ['builds robots'], quotes: ['robots need hats'] });

    // The face pages came back with new ids: recognised, Flo gets the notes in the prompt.
    setPeople([{ ...flo, id: 's2-p1' }], t0 + 61_000);
    expect(memoryContext(t0 + 61_000)).toContain('builds robots');
  });

  it('drops what expired while the server was down', () => {
    const t0 = Date.now();
    restoreTonight(t0);
    setPeople([flo], t0);
    recordFieldNotes('[[NOTE: builds robots]] [[QUOTE: robots need hats]]', t0);
    flushTonight(t0);
    expect(restart(t0 + NOTES_TTL_MS + 60_000)).toBe(0);
    expect(tonightsPeople(t0 + NOTES_TTL_MS + 60_000)).toMatchObject({ people: [] });
  });

  it('is written a few seconds after a change, atomically, with nothing left behind', () => {
    vi.useFakeTimers();
    restoreTonight();
    setPeople([flo]);
    recordFieldNotes('[[NOTE: builds robots]]');
    expect(existsSync(file())).toBe(false);
    vi.advanceTimersByTime(TONIGHT_WRITE_DELAY_MS);
    expect(saved().people.map((person) => person.notes)).toEqual([['builds robots']]);
    expect(readdirSync(dir)).toEqual(['tonight.json']);
  });

  // Forgetting someone is the operator's privacy action: it must not come
  // back after a crash a second later.
  it('is emptied at once when the operator forgets someone or clears tonight', () => {
    vi.useFakeTimers();
    restoreTonight();
    setPeople([flo]);
    recordFieldNotes('[[NOTE: builds robots]] [[QUOTE: robots need hats]]');
    setPeople([stranger]);
    recordFieldNotes('[[NOTE: bakes bread at night]]');
    vi.advanceTimersByTime(TONIGHT_WRITE_DELAY_MS);
    expect(saved().people).toHaveLength(2);

    forgetPeople(['s1-p1']);
    expect(saved().people.map((person) => person.id)).toEqual(['s1-p2']);
    expect(saved().quotes).toEqual([]);
    clearTonight();
    expect(saved().people).toEqual([]);
    expect(restart(Date.now())).toBe(0);
  });

  it('starts empty from a broken or foreign file, and memory only without TUBS_TONIGHT_FILE', () => {
    writeFileSync(file(), '{not json');
    expect(restart(Date.now())).toBe(0);
    writeFileSync(file(), JSON.stringify({ version: 2, people: [{ id: 'x' }] }));
    expect(restart(Date.now())).toBe(0);
    delete process.env.TUBS_TONIGHT_FILE;
    expect(restoreTonight()).toBe(0);
    setPeople([flo]);
    recordFieldNotes('[[NOTE: builds robots]]');
    flushTonight();
    expect(readFileSync(file(), 'utf8')).toBe(JSON.stringify({ version: 2, people: [{ id: 'x' }] }));
  });
});
