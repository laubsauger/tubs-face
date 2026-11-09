import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTagFilter, endVisit, extractFieldNotes, fieldNotesSnapshot, hasNotesInView, memoryContext, NOTES_TTL_MS, peopleInView, pickGossip,
  markNameAsked, nameAskCandidate, noteTurn, onEnrollRequest, recordFieldNotes, resetFieldNotes, setPeople,
} from './field-notes.js';

// Tubs remembering things about people is the point; leaking a note into
// speech, or filing it under the wrong person, is the failure.

const anna = { id: 'a1', names: [], position: 'left' as const };
const ben = { id: 'b2', names: [], position: 'right' as const };

describe('field notes', () => {
  beforeEach(() => resetFieldNotes());

  it('reads note and quote tags with an optional position, also from dual-head JSON', () => {
    expect(extractFieldNotes('Nice hat. [[NOTE right: dentist]] [[QUOTE: "AI art is real art"]]')).toEqual([
      { kind: 'note', position: 'right', text: 'dentist' },
      { kind: 'quote', position: null, text: 'AI art is real art' },
    ]);
    expect(extractFieldNotes('{"beats":[{"text":"Hi. [[NOTE middle: likes jazz]]"}]}')[0]).toMatchObject({ position: 'center' });
  });

  it('files a note under the only person in view', () => {
    setPeople([anna], 0);
    recordFieldNotes('Sure. [[NOTE: works in marketing]]', 1);
    expect(fieldNotesSnapshot(2).people[0]).toMatchObject({ id: 'a1', notes: ['works in marketing'] });
  });

  it('in a group, files notes by position, and unattributed ones under the group', () => {
    setPeople([anna, ben], 0);
    recordFieldNotes('[[NOTE left: dentist]] [[NOTE right: hates jazz]] [[NOTE: came together]]', 1);
    const snap = fieldNotesSnapshot(2);
    expect(snap.people.map((p) => p.notes)).toEqual([['dentist'], ['hates jazz']]);
    expect(snap.groupNotes).toEqual(['came together']);
    expect(memoryContext(2)).toContain('On the left: dentist');
    expect(memoryContext(2)).toContain('On the right: hates jazz');
  });

  it('brings a person their notes back hours later, wherever they stand', () => {
    setPeople([anna], 0);
    recordFieldNotes('[[NOTE: works in marketing]]', 1);
    setPeople([ben], 60_000);
    expect(memoryContext(60_000)).toBe('');

    setPeople([{ ...anna, position: 'right', awayMs: 2 * 3600_000 }], 2 * 3600_000);
    const memory = memoryContext(2 * 3600_000);
    expect(memory).toContain('- works in marketing');
    expect(memory).toContain('You met them earlier tonight');
  });

  it('forgets everything after the night is over', () => {
    setPeople([anna], 0);
    recordFieldNotes('[[NOTE: likes jazz]]', 0);
    setPeople([anna], NOTES_TTL_MS + 1);
    expect(memoryContext(NOTES_TTL_MS + 1)).toBe('');
  });

  it('gossips only about people no longer in view', () => {
    setPeople([anna], 0);
    recordFieldNotes('Fine. [[QUOTE: marketing is art]]', 0);
    expect(pickGossip(() => 0, 1)).toBeNull();
    setPeople([ben], 10);
    expect(pickGossip(() => 0, 11)).toEqual({ text: 'marketing is art', name: null });
    // Enrolled people are named in gossip.
    setPeople([{ id: 'c3', names: ['Cleo'], position: 'center' }], 20);
    recordFieldNotes('[[QUOTE: robots cannot love]]', 21);
    setPeople([ben], 30);
    expect(pickGossip(() => 0.99, 31)).toEqual({ text: 'robots cannot love', name: 'Cleo' });
  });

  it('drops anonymous and group notes when the visit ends, keeps personal ones', () => {
    recordFieldNotes('[[NOTE: wears a red hoodie]]', 0);
    expect(fieldNotesSnapshot(0).people[0]?.notes).toEqual(['wears a red hoodie']);
    endVisit();
    expect(fieldNotesSnapshot(1).people).toEqual([]);
  });

  it('tells the roast mirror who is here and how much Tubs knows about each', () => {
    setPeople([anna, ben], 0);
    recordFieldNotes('[[NOTE right: owns three phones]]', 1);
    expect(peopleInView()).toEqual([{ position: 'left', name: null, noteCount: 0 }, { position: 'right', name: null, noteCount: 1 }]);
    expect(hasNotesInView()).toBe(true);
  });
});

describe('note merging', () => {
  beforeEach(() => resetFieldNotes());

  it('keeps single facts when the model repeats and extends its list', () => {
    setPeople([anna], 0);
    recordFieldNotes('[[NOTE: dentist, hates jazz]]', 1);
    recordFieldNotes('[[NOTE: dentist, hates jazz, flew in from Berlin]]', 2);
    recordFieldNotes('[[NOTE: dentist from Berlin, in a band called Plastic Saints]]', 3);
    expect(fieldNotesSnapshot(4).people[0]!.notes).toEqual(['hates jazz', 'flew in from Berlin', 'dentist from Berlin', 'in a band called Plastic Saints']);
  });
});

// The sentence splitter must never see half a tag, or TTS would read it out.
describe('stream tag filter', () => {
  it('holds a tag split across deltas and drops it whole', () => {
    const filter = createTagFilter();
    const out = ['Nice hat. [', '[NOTE: wears a fedora, works ', 'in marketing. Likes jazz]] Next.', ' Done.'].map((delta) => filter.push(delta)).join('') + filter.flush();
    expect(out).toBe('Nice hat.  Next. Done.');
  });

  // "[NOTE: testing shit]" with one bracket was shown and its note lost.
  it('takes a tag with one bracket as a note too, and never lets it reach speech', () => {
    expect(extractFieldNotes('Fair. [NOTE: testing the mic] [QUOTE right: test some shit]')).toEqual([
      { kind: 'note', position: null, text: 'testing the mic' },
      { kind: 'quote', position: 'right', text: 'test some shit' },
    ]);
    const filter = createTagFilter();
    const out = ['Fair enough. [', 'NO', 'TE: testing ', 'the mic] Go on.', ' [No problem] here.'].map((delta) => filter.push(delta)).join('') + filter.flush();
    expect(out).toBe('Fair enough.  Go on. [No problem] here.');
    const unclosed = createTagFilter();
    expect(unclosed.push('Sure. [NOTE: never closed') + unclosed.flush()).toBe('Sure. ');
  });

  it('drops any complete marker, and an unclosed tag at the end', () => {
    const filter = createTagFilter();
    expect(filter.push('Fine. [[SHOW_QR]] ')).toBe('Fine.  ');
    expect(filter.push('[[NOTE: never closed')).toBe('');
    expect(filter.flush()).toBe('');
  });
});

// Auto onboarding: Tubs asks an unnamed person their name once they have
// talked a bit, and their face is saved the moment they say it.
describe('auto onboarding', () => {
  beforeEach(() => {
    resetFieldNotes();
    onEnrollRequest(null);
  });

  it('asks an unnamed person their name only after a couple of turns, and only once', () => {
    setPeople([{ id: 'u1', names: [], position: 'center', snapshots: 2 }], 0);
    noteTurn();
    expect(nameAskCandidate()).toBeNull();
    noteTurn();
    expect(nameAskCandidate()).toEqual({ position: 'center', inGroup: false });
    markNameAsked('center');
    expect(nameAskCandidate()).toBeNull();
  });

  it('never asks someone already known, or without snapshots to enroll from', () => {
    setPeople([{ id: 'k1', names: ['Anna'], position: 'left', snapshots: 0 }, { id: 'n1', names: [], position: 'right' }], 0);
    noteTurn();
    noteTurn();
    expect(nameAskCandidate()).toBeNull();
  });

  it('enrolls the right person the moment they say their name, once', () => {
    const enrolled: Array<[string, string]> = [];
    onEnrollRequest((id, name) => enrolled.push([id, name]));
    setPeople([{ id: 'u1', names: [], position: 'left', snapshots: 3 }, { id: 'u2', names: [], position: 'right', snapshots: 1 }], 0);
    recordFieldNotes('Nice to meet you. [[NAME right: Ben]]', 1);
    recordFieldNotes('[[NAME right: Ben]]', 2);
    expect(enrolled).toEqual([['u2', 'Ben']]);
    expect(fieldNotesSnapshot(3).people[1]!.names).toEqual(['Ben']);
  });

  it('uses a name given without snapshots for this visit, but cannot enroll it', () => {
    const enrolled: string[] = [];
    onEnrollRequest((_id, name) => enrolled.push(name));
    setPeople([{ id: 'u1', names: [], position: 'center' }], 0);
    recordFieldNotes('[[NAME: Cleo]]', 1);
    expect(enrolled).toEqual([]);
    expect(memoryContext(2)).toContain('Name: Cleo');
  });
});
