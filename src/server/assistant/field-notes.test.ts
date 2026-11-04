import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTagFilter, endVisit, extractFieldNotes, fieldNotesSnapshot, memoryContext, NOTES_TTL_MS, pickGossip, recordFieldNotes, resetFieldNotes,
  setCurrentVisitor, stripFieldNoteTags,
} from './field-notes.js';

// Tubs remembering things about people is the point; leaking a note into
// speech, or mixing up whose note is whose, is the failure.

describe('field notes', () => {
  beforeEach(() => resetFieldNotes());

  it('reads note and quote tags, also from dual-head JSON', () => {
    expect(extractFieldNotes('Nice hat. [[NOTE: works in marketing, hates phones]] [[QUOTE: "AI art is real art"]]')).toEqual({
      notes: ['works in marketing, hates phones'], quotes: ['AI art is real art'],
    });
    expect(extractFieldNotes('{"beats":[{"text":"Hi. [[QUOTE: \\"robots cannot love\\"]]"}]}').quotes).toEqual(['robots cannot love']);
  });

  it('keeps notes per visitor and brings them back when that visitor returns hours later', () => {
    setCurrentVisitor('a1', [], 0);
    recordFieldNotes('Sure. [[NOTE: works in marketing]]', 1000);
    setCurrentVisitor('b2', [], 60_000);
    expect(memoryContext(60_000)).toBe('');

    setCurrentVisitor('a1', [], 2 * 3600_000);
    const memory = memoryContext(2 * 3600_000);
    expect(memory).toContain('- works in marketing');
    expect(memory).toContain('You met them earlier tonight');
  });

  it('forgets everything after the night is over', () => {
    setCurrentVisitor('a1', [], 0);
    recordFieldNotes('[[NOTE: likes jazz]]', 0);
    setCurrentVisitor('a1', [], NOTES_TTL_MS + 1);
    expect(memoryContext(NOTES_TTL_MS + 1)).toBe('');
  });

  it('gossips only about other visitors', () => {
    setCurrentVisitor('a1', [], 0);
    recordFieldNotes('Fine. [[QUOTE: marketing is art]]', 0);
    expect(pickGossip(() => 0, 1)).toBeNull();
    setCurrentVisitor('b2', [], 10);
    expect(pickGossip(() => 0, 11)).toBe('marketing is art');
  });

  it('drops anonymous notes (camera off) when the visit ends', () => {
    recordFieldNotes('[[NOTE: wears a red hoodie]]', 0);
    expect(fieldNotesSnapshot(0).notes).toEqual(['wears a red hoodie']);
    endVisit();
    expect(fieldNotesSnapshot(1).notes).toEqual([]);
  });

  it('strips note tags but leaves the QR marker for the donation check', () => {
    expect(stripFieldNoteTags('Pay up. [[SHOW_QR]] [[NOTE: cheap]]')).toBe('Pay up. [[SHOW_QR]]');
  });
});

// The sentence splitter must never see half a tag, or TTS would read it out.
describe('stream tag filter', () => {
  it('holds a tag split across deltas and drops it whole', () => {
    const filter = createTagFilter();
    const out = ['Nice hat. [', '[NOTE: wears a fedora, works ', 'in marketing. Likes jazz]] Next.', ' Done.'].map((delta) => filter.push(delta)).join('') + filter.flush();
    expect(out).toBe('Nice hat.  Next. Done.');
  });

  it('passes the QR marker through and drops an unclosed tag at the end', () => {
    const filter = createTagFilter();
    expect(filter.push('Venmo me. [[SHOW_QR]] ')).toBe('Venmo me. [[SHOW_QR]] ');
    expect(filter.push('[[NOTE: never closed')).toBe('');
    expect(filter.flush()).toBe('');
  });
});

describe('note merging', () => {
  beforeEach(() => resetFieldNotes());

  it('keeps single facts when the model repeats and extends its list', () => {
    setCurrentVisitor('d1', [], 0);
    recordFieldNotes('[[NOTE: dentist, hates jazz]]', 1);
    recordFieldNotes('[[NOTE: dentist, hates jazz, flew in from Berlin]]', 2);
    recordFieldNotes('[[NOTE: dentist from Berlin, in a band called Plastic Saints]]', 3);
    expect(fieldNotesSnapshot(4).notes).toEqual(['hates jazz', 'flew in from Berlin', 'dentist from Berlin', 'in a band called Plastic Saints']);
  });
});
