import { describe, expect, it } from 'vitest';
import type { ChatEntry } from '../../state/app-state.js';
import { TRANSCRIPT_HOLD_MS, isTranscriptShown, selectTranscriptLines, transcriptKey } from './transcript.js';

let nextId = 0;
const entry = (fields: Partial<ChatEntry> & Pick<ChatEntry, 'type' | 'text'>): ChatEntry => ({
  id: `e${nextId++}`,
  ts: 1000 + nextId,
  ...fields,
});

// The floating transcript lets the operator follow the conversation over the
// face without opening the chat log.
describe('selectTranscriptLines', () => {
  it('shows only the newest few lines, oldest first', () => {
    const entries = ['one', 'two', 'three', 'four', 'five', 'six'].map((text) => entry({ type: 'in', actor: 'user', text }));
    expect(selectTranscriptLines(entries, 4).map((line) => line.text)).toEqual(['three', 'four', 'five', 'six']);
  });

  it('keeps fillers but marks them, so a filler is never mistaken for a reply', () => {
    const lines = selectTranscriptLines([
      entry({ type: 'in', actor: 'user', text: 'What is this?' }),
      entry({ type: 'out', actor: 'main', text: 'Um, okay.', filler: true }),
      entry({ type: 'out', actor: 'main', text: 'An art piece, obviously.' }),
    ]);
    expect(lines.map((line) => [line.text, line.filler])).toEqual([
      ['What is this?', false],
      ['Um, okay.', true],
      ['An art piece, obviously.', false],
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
