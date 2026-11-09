import { describe, expect, it } from 'vitest';
import type { EnrolledFace } from '../../shared/contracts/faces.js';
import { FAR_OFF_SIMILARITY, existingPerson, libraryPeople, similarityQuestion, similarityToPerson, suggestPeople, uploadVerdict } from './person-match.js';

// Adding photos to someone already known: the picker finds them as the
// operator types, samples that don't look like them are not saved without a
// question (Tubs would greet a stranger as Flo), and an upload is used only
// with exactly one face in it.

const face = (id: string, name: string, embedding: number[], createdAt = 1): EnrolledFace => ({ id, name, embedding, createdAt, thumbnail: `data:image/jpeg;base64,${id}` });
const LIBRARY = [
  face('f1', 'Flo', [1, 0, 0], 1), face('f2', 'Flo', [0.95, 0.31, 0], 2),
  face('d1', 'Dimi', [0, 1, 0]), face('fl1', 'Florian', [0, 0, 1]),
];

describe('the person picker', () => {
  it('suggests people by what is typed, names starting with it first, with their sample count and newest photo', () => {
    const people = libraryPeople(LIBRARY);
    expect(suggestPeople(people, 'fl').map((person) => person.name)).toEqual(['Flo', 'Florian']);
    expect(suggestPeople(people, 'mi').map((person) => person.name)).toEqual(['Dimi']);
    expect(people.find((person) => person.name === 'Flo')).toEqual({ name: 'Flo', samples: 2, thumbnail: 'data:image/jpeg;base64,f2' });
  });

  it('takes a typed name as the existing person whatever its case, else as someone new', () => {
    const people = libraryPeople(LIBRARY);
    expect(existingPerson(people, ' flo ')?.name).toBe('Flo');
    expect(existingPerson(people, 'Rosa')).toBeNull();
  });
});

describe('similarity to the person the samples go to', () => {
  it('is high for samples like theirs and asks first when far under the threshold', () => {
    const alike = similarityToPerson([{ embedding: [0.98, 0.2, 0] }], LIBRARY, 'flo');
    expect(alike!.score).toBeGreaterThan(0.9);
    expect(alike!.farOff).toBe(false);
    const stranger = similarityToPerson([{ embedding: [0, 0.2, 0.98] }], LIBRARY, 'Flo');
    expect(stranger!.score).toBeLessThan(FAR_OFF_SIMILARITY);
    expect(stranger!.farOff).toBe(true);
    expect(similarityQuestion(stranger!, 'Flo')).toMatch(/^These look like a different person: \d+%$/);
    // Someone new has nothing to compare with.
    expect(similarityToPerson([{ embedding: [1, 0, 0] }], LIBRARY, 'Rosa')).toBeNull();
  });

  // Seen live: Flo's shots matched Dimi at 54% (over the far-off line) because
  // a few of Dimi's samples were already Flo's; they matched Flo at 77%. Saved
  // without a question, each wrong pick makes the next one easier.
  it('also asks first when the samples look clearly more like someone else, even over the far-off line', () => {
    const mixedUp = [...LIBRARY, face('d2', 'Dimi', [0.55, 0.835, 0])];
    const flosShot = [{ embedding: [0.98, 0.2, 0] }];
    const intoDimi = similarityToPerson(flosShot, mixedUp, 'Dimi')!;
    expect(intoDimi.farOff).toBe(false);
    expect(intoDimi.likelier?.name).toBe('Flo');
    expect(intoDimi.ask).toBe(true);
    expect(similarityQuestion(intoDimi, 'Dimi')).toMatch(/^These look more like Flo \(\d+%\) than Dimi \(\d+%\)$/);
    // Into the right person: no question.
    const intoFlo = similarityToPerson(flosShot, mixedUp, 'Flo')!;
    expect(intoFlo.ask).toBe(false);
    expect(similarityQuestion(intoFlo, 'Flo')).toBeNull();
  });
});

describe('an uploaded photo', () => {
  it('is used only with exactly one face in it', () => {
    expect(uploadVerdict(0)).toEqual({ ok: false, reason: 'no face found' });
    expect(uploadVerdict(2)).toEqual({ ok: false, reason: '2 faces: use a photo of one person' });
    expect(uploadVerdict(1)).toEqual({ ok: true });
  });
});
