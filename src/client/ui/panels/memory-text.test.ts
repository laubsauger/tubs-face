import { describe, expect, it } from 'vitest';
import type { MemoryCard } from '../../../shared/contracts/memory.js';
import { clearText, flagText, forgetText, movePhotosText, removePersonText, removePhotosText, restoreText, takenWhen } from './memory-text.js';

// "The confirm step doesn't say what will happen": each confirmation names the
// person, the counts and what stays, before anything is deleted or moved, and
// says when it can no longer be undone.

const at = (day: number, hour: number, minute: number) => new Date(2026, 1, day, hour, minute).getTime();
const sample = (id: string, createdAt: number, index: number) => ({ id, createdAt, photo: `/memory/photo/${id}`, index, flag: null });
const rapha: Pick<MemoryCard, 'name' | 'notes' | 'quotes' | 'turns' | 'enrolled' | 'library'> = {
  name: 'Rapha',
  notes: ['plays bass', 'from Lisbon', 'hates techno'],
  quotes: ['one more', 'no'],
  turns: 11,
  enrolled: true,
  library: [1, 2, 3, 4, 5, 6].map((n) => sample(`r${n}`, at(11, 21, 40 + n), n)),
};

describe('memory view confirmations', () => {
  it('forget tonight: what goes (notes, quotes, the turns counted) and that the face samples stay', () => {
    expect(forgetText(rapha)).toBe('Forget tonight: deletes the 3 notes and 2 quotes Tubs kept about Rapha tonight, and that Rapha was here (11 turns); the conversation itself and Rapha\'s 6 face samples stay.');
    expect(forgetText({ ...rapha, name: null, enrolled: false, library: [], notes: ['1'], quotes: [], turns: 1 }))
      .toBe('Forget tonight: deletes the 1 note and 0 quotes Tubs kept about this visitor tonight, and that this visitor was here (1 turn); the conversation itself and no face samples are touched.');
  });

  it('remove a person: every sample, permanently, recognition gone, notes stay, undo only for a minute', () => {
    expect(removePersonText(rapha)).toBe('Remove from face library: deletes all 6 face samples of Rapha permanently; Tubs stops recognising Rapha. Tonight\'s notes stay. It cannot be undone after a minute (a backup is kept).');
  });

  it('remove photos: how many, when they were taken, and what is left', () => {
    expect(removePhotosText(rapha, ['r3'])).toBe('Remove 1 photo of Rapha (taken 11 Feb 21:43): deleted from the face library; Rapha\'s other 5 samples stay. It cannot be undone after a minute (a backup is kept).');
    expect(removePhotosText(rapha, rapha.library.map((entry) => entry.id))).toContain('6 photos of Rapha (taken 11 Feb 21:41 to 11 Feb 21:46)');
    expect(removePhotosText(rapha, rapha.library.map((entry) => entry.id))).toContain('that is all of Rapha\'s samples: Tubs stops recognising Rapha');
  });

  it('move photos: from whom to whom, both counts after', () => {
    expect(movePhotosText(rapha, ['r3'], 'Flo', 59)).toBe('Move 1 photo from Rapha to Flo (taken 11 Feb 21:43): Tubs matches it as Flo from now on (Flo then has 60); Rapha keeps 5 samples. Undo for a minute.');
  });

  it('clear tonight and restore a backup name their counts', () => {
    expect(clearText(4)).toBe('Clear tonight: deletes every note and quote Tubs kept tonight, about all 4 people; the conversation and the face library stay.');
    expect(restoreText(at(9, 17, 20), {
      back: [{ name: 'Vincent', samples: 8 }, { name: 'Anderson', samples: 6 }],
      gone: [],
      changed: [{ name: 'Rapha', from: 5, to: 6 }],
      unchanged: ['Flo'],
    })).toBe('Restore the face library as it was at 9 Feb 17:20: brings back Vincent (8), Anderson (6); Rapha 5 → 6; Flo unchanged. The library now is kept as a backup first.');
  });

  it('flags a photo in a few words', () => {
    expect(flagText({ looksLike: { name: 'Flo', sim: 0.753 }, unlikeOwn: true, like: { name: 'Flo', sim: 0.753 } }, 'Rapha')).toEqual(['looks like Flo · 75%', 'unlike Rapha\'s others']);
    expect(takenWhen([{ createdAt: null }])).toBe('(undated)');
  });
});
