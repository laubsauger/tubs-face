import { describe, expect, it } from 'vitest';
import type { SpokenItem, VoiceClock } from '../../audio/voice-clock.js';
import type { ChatEntry } from '../../state/app-state.js';
import {
  TRANSCRIPT_HOLD_MS,
  TYPE_CHARS_PER_SECOND,
  VOICE_WAIT_MS,
  isTranscriptShown,
  nextTyping,
  revealedChars,
  selectTranscriptLines,
  transcriptKey,
  type TranscriptLine,
  type Typing,
} from './transcript.js';

let nextId = 0;
const entry = (fields: Partial<ChatEntry> & Pick<ChatEntry, 'type' | 'text'>): ChatEntry => ({
  id: `e${nextId++}`,
  ts: 1000 + nextId,
  ...fields,
});

// The floating transcript lets the operator follow the conversation over the
// face without opening the chat log.
describe('selectTranscriptLines', () => {
  // A filler and the reply after it come from the same head: one bubble, the
  // filler as its lead-in, so the transcript shows everything that was heard
  // without a separate line for a "Hmm.".
  it('puts a filler in front of the same head\'s next reply, and leaves it alone otherwise', () => {
    const lines = selectTranscriptLines([
      entry({ type: 'in', actor: 'user', text: 'Nice hat?' }),
      entry({ type: 'out', actor: 'main', text: 'Hmm.', filler: true }),
      entry({ type: 'out', actor: 'main', text: '😏 It looks like it lost a bet.' }),
      entry({ type: 'in', actor: 'user', text: 'Rude.' }),
      entry({ type: 'out', actor: 'main', text: 'Mhm.', filler: true }),
      entry({ type: 'out', actor: 'small', text: 'He is always rude.' }),
    ], 10);
    expect(lines.map((l) => [l.actor, l.lead, l.text, l.filler])).toEqual([
      ['user', '', 'Nice hat?', false],
      ['main', 'Hmm.', 'It looks like it lost a bet.', false],
      ['user', '', 'Rude.', false],
      ['main', '', 'Mhm.', true],
      ['small', '', 'He is always rude.', false],
    ]);
  });

  it('shows only the newest few lines, oldest first', () => {
    const entries = ['one', 'two', 'three', 'four', 'five', 'six'].map((text) => entry({ type: 'in', actor: 'user', text }));
    expect(selectTranscriptLines(entries, 4).map((line) => line.text)).toEqual(['three', 'four', 'five', 'six']);
  });

  // Shown in the reply's bubble, the filler still stays apart from the reply's
  // text, so it is never mistaken for something the model said.
  it('keeps a filler apart from the reply it leads into', () => {
    const lines = selectTranscriptLines([
      entry({ type: 'in', actor: 'user', text: 'What is this?' }),
      entry({ type: 'out', actor: 'main', text: 'Um, okay.', filler: true }),
      entry({ type: 'out', actor: 'main', text: 'An art piece, obviously.' }),
    ]);
    expect(lines.map((line) => [line.lead, line.text])).toEqual([
      ['', 'What is this?'],
      ['Um, okay.', 'An art piece, obviously.'],
    ]);
  });

  it('leaves out system notices, which are not part of the conversation', () => {
    const lines = selectTranscriptLines([
      entry({ type: 'sys', actor: 'system', text: 'Connected to Tubs Bridge Server' }),
      entry({ type: 'out', actor: 'main', text: 'Hello.' }),
    ]);
    expect(lines.map((line) => line.text)).toEqual(['Hello.']);
  });

  it('tells the two heads apart and lifts the reply emoji out of the text', () => {
    const lines = selectTranscriptLines([
      entry({ type: 'out', actor: 'main', text: '😤 Oh, you again.' }),
      entry({ type: 'out', actor: 'small', text: '🙂 Be nice.' }),
    ]);
    expect(lines.map((line) => [line.actor, line.emoji, line.text])).toEqual([
      ['main', '😤', 'Oh, you again.'],
      ['small', '🙂', 'Be nice.'],
    ]);
  });

  it('never strips an emoji a visitor typed', () => {
    const [line] = selectTranscriptLines([entry({ type: 'in', actor: 'user', text: '👋 hi Tubs' })]);
    expect(line?.text).toBe('👋 hi Tubs');
  });
});

describe('transcript fade', () => {
  it('stays up while the conversation goes on and fades after ~20 s of quiet', () => {
    expect(isTranscriptShown(0, TRANSCRIPT_HOLD_MS - 1)).toBe(true);
    expect(isTranscriptShown(0, TRANSCRIPT_HOLD_MS)).toBe(false);
    expect(isTranscriptShown(null, 0)).toBe(false);
  });

  it('restarts the hold when a new line arrives or a streaming reply grows', () => {
    const first = selectTranscriptLines([entry({ type: 'out', actor: 'main', text: 'Nice', draft: true })]);
    const grown = [{ ...first[0]!, text: 'Nice hat.' }];
    const added = [...grown, ...selectTranscriptLines([entry({ type: 'in', actor: 'user', text: 'Thanks' })])];
    expect(transcriptKey(grown)).not.toBe(transcriptKey(first));
    expect(transcriptKey(added)).not.toBe(transcriptKey(grown));
    expect(transcriptKey(first)).toBe(transcriptKey([...first]));
  });
});

const line = (fields: Partial<TranscriptLine> & Pick<TranscriptLine, 'id' | 'actor'>): TranscriptLine => ({
  emoji: '',
  text: 'Some reply.',
  filler: false,
  lead: '',
  draft: false,
  ...fields,
});
const clock = (items: SpokenItem[], quietAt: number | null = null): VoiceClock => ({ items, quietAt });
const said = (chars: number, startedAt: number, seconds: number, open = false): SpokenItem => ({ chars, startedAt, seconds, open });

// Replies type out instead of landing all at once, but a card that is already
// up is never typed again: visitors must be able to read every reply in full.
describe('which card types out', () => {
  it('types a new reply from either head; a visitor sees their own words and fillers at once', () => {
    const none = new Set<string>();
    expect(nextTyping(null, none, [line({ id: 'a', actor: 'main' })], 10)).toEqual({ id: 'a', actor: 'main', startedAt: 10, shown: 0 });
    expect(nextTyping(null, none, [line({ id: 'b', actor: 'small' })], 10)).toMatchObject({ id: 'b', actor: 'small' });
    expect(nextTyping(null, none, [line({ id: 'c', actor: 'user' })], 10)).toBeNull();
    expect(nextTyping(null, none, [line({ id: 'd', actor: 'main', filler: true })], 10)).toBeNull();
  });

  it('never types a card twice: not one already up, not on an unrelated re-render, not when a newer line goes away', () => {
    const reply = line({ id: 'r', actor: 'main' });
    expect(nextTyping(null, new Set(['r']), [reply], 0)).toBeNull();

    const typing: Typing = { id: 'r', actor: 'main', startedAt: 0, shown: 5 };
    expect(nextTyping(typing, new Set(['r']), [reply], 1000)).toBe(typing);

    // A visitor's half-heard words show up under it, then are dropped again.
    const guest = line({ id: 'g', actor: 'user' });
    const withGuest = nextTyping(typing, new Set(['r']), [reply, guest], 2000);
    expect(withGuest).toBeNull();
    expect(nextTyping(withGuest, new Set(['r', 'g']), [reply], 3000)).toBeNull();
  });

  it('types only the newest card: a newer reply ends the typing of the one before', () => {
    const typing: Typing = { id: 'm', actor: 'main', startedAt: 0, shown: 3 };
    const lines = [line({ id: 'm', actor: 'main' }), line({ id: 's', actor: 'small' })];
    expect(nextTyping(typing, new Set(['m']), lines, 500)).toEqual({ id: 's', actor: 'small', startedAt: 500, shown: 0 });
  });

  it('keeps typing a streamed reply where it was when it is committed under its final id', () => {
    const guest = line({ id: 'g', actor: 'user' });
    const typing: Typing = { id: 'draft-out', actor: 'main', startedAt: 100, shown: 7 };
    const committed = line({ id: '1730-abc', actor: 'main', text: 'One. Two. Three.' });
    expect(nextTyping(typing, new Set(['g', 'draft-out']), [guest, committed], 900)).toEqual({ ...typing, id: '1730-abc' });
  });

  it('shows replies whole with reduced motion', () => {
    expect(nextTyping(null, new Set(), [line({ id: 'r', actor: 'main' })], 0, true)).toBeNull();
  });
});

describe('how much of a reply shows', () => {
  const text = 'First sentence. Second one here.';
  const typing: Typing = { id: 'r', actor: 'main', startedAt: 1000, shown: 0 };

  it('follows the voice: each sentence as its audio plays, nothing of the next before its voice starts', () => {
    const first = said(15, 1050, 1);
    expect(revealedChars(typing, text, clock([first]), 1550)).toBe(7);
    // Sentence one is said; sentence two's audio hasn't started (TTS behind).
    expect(revealedChars(typing, text, clock([first]), 3000)).toBe(15);
    const second = said(16, 3000, 2);
    expect(revealedChars(typing, text, clock([first, second]), 4000)).toBe(15 + 8);
  });

  it('shows all of it once the voice goes quiet, done or cut off', () => {
    expect(revealedChars(typing, text, clock([said(15, 1050, 1)], 1300), 1300)).toBe(text.length);
  });

  it('does not take the end of the reply before for the end of this one', () => {
    const previousReply = said(30, 900, 0.05);
    expect(revealedChars(typing, text, clock([previousReply], 980), 1500)).toBe(0);
  });

  it('holds back the end of a reply whose audio is still streaming in, as its length is a guess', () => {
    const streaming = said(text.length, 1000, 2, true);
    expect(revealedChars(typing, text, clock([streaming]), 9000)).toBeLessThan(text.length);
  });

  it('waits for its own voice (a filler may still be talking) rather than running ahead of it', () => {
    const filler = said(9, 500, 1.2);
    expect(revealedChars(typing, text, clock([filler]), 1000 + VOICE_WAIT_MS - 1)).toBe(0);
    // No voice after all (no audio): it types on its own.
    expect(revealedChars(typing, text, clock([filler]), 1000 + VOICE_WAIT_MS + 1000)).toBe(TYPE_CHARS_PER_SECOND);
  });

  it("types Mini's lines (voiced in Mini's own window) from the start, done before Mini's ~15 chars/s voice", () => {
    const mini: Typing = { id: 's', actor: 'small', startedAt: 0, shown: 0 };
    const reply = 'x'.repeat(150);
    expect(revealedChars(mini, reply, clock([said(40, 10, 3)]), 1000)).toBe(TYPE_CHARS_PER_SECOND);
    expect(revealedChars(mini, reply, clock([]), (reply.length / 15) * 1000)).toBe(reply.length);
  });

  it('never takes back characters already shown', () => {
    const ahead: Typing = { ...typing, shown: 20 };
    expect(revealedChars(ahead, text, clock([said(15, 1050, 1)]), 1100)).toBe(20);
  });
});
