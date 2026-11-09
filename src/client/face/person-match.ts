// Adding samples to someone who is already in the face library: finding them
// by name as the operator types, and checking that the new samples look like
// them before they are saved (a wrong pick would teach Tubs to greet a
// stranger by their name).

import type { EnrolledFace } from '../../shared/contracts/faces.js';
import { groupLibrary } from './library-sessions.js';
import { MATCH_THRESHOLD, cosineSimilarity } from './matching.js';

/** New samples this far under the match threshold look like someone else: the operator confirms first. */
export const FAR_OFF_SIMILARITY = 0.5;
const MAX_SUGGESTIONS = 6;

export interface LibraryPersonSummary {
  name: string;
  samples: number;
  /** The newest sample's thumbnail, for the picker. */
  thumbnail: string | null;
}

export function libraryPeople(faces: readonly EnrolledFace[]): LibraryPersonSummary[] {
  return groupLibrary(faces).map((person) => {
    const newest = person.sessions.flatMap((session) => session.faces)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .find((face) => face.thumbnail);
    return { name: person.name, samples: person.samples, thumbnail: newest?.thumbnail ?? null };
  });
}

/** People whose name starts with (first) or contains what is typed, case and spaces aside. */
export function suggestPeople(people: readonly LibraryPersonSummary[], typed: string): LibraryPersonSummary[] {
  const query = typed.trim().toLowerCase();
  if (!query) return people.slice(0, MAX_SUGGESTIONS);
  const starts = people.filter((person) => person.name.toLowerCase().startsWith(query));
  const contains = people.filter((person) => !person.name.toLowerCase().startsWith(query) && person.name.toLowerCase().includes(query));
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

/** The library's person for a typed name ("flo" is Flo), or null for someone new. */
export function existingPerson(people: readonly LibraryPersonSummary[], typed: string): LibraryPersonSummary | null {
  const key = typed.trim().toLowerCase();
  return key ? people.find((person) => person.name.toLowerCase() === key) ?? null : null;
}

export interface PersonSimilarity {
  /** How alike the new samples are to the person's, 0..1: each new one's best match, averaged. */
  score: number;
  /** Far under the threshold: ask before saving. */
  farOff: boolean;
  /** Someone else in the library they match clearly better (a wrong pick, or a person already mixed up with another). */
  likelier: { name: string; score: number } | null;
  /** Ask before saving: far off, or likelier someone else. */
  ask: boolean;
  threshold: number;
}

/** How much better another person must match before the samples count as theirs rather than the target's. */
const LIKELIER_MARGIN = 0.05;

/** Each new sample's best match among these, averaged. */
function alikeness(samples: ReadonlyArray<{ embedding: number[] }>, theirs: readonly EnrolledFace[]): number {
  const best = samples.map((sample) => Math.max(...theirs.map((face) => cosineSimilarity(sample.embedding, face.embedding))));
  return Math.max(0, best.reduce((sum, value) => sum + value, 0) / best.length);
}

/** null when the person has no samples yet (nothing to compare with). */
export function similarityToPerson(samples: ReadonlyArray<{ embedding: number[] }>, library: readonly EnrolledFace[], name: string): PersonSimilarity | null {
  const key = (face: EnrolledFace) => face.name.trim().toLowerCase();
  const target = name.trim().toLowerCase();
  const known = library.filter((face) => face.embedding.length > 0);
  const theirs = known.filter((face) => key(face) === target);
  if (theirs.length === 0 || samples.length === 0) return null;
  const score = alikeness(samples, theirs);
  let likelier: PersonSimilarity['likelier'] = null;
  for (const other of new Set(known.map(key).filter((other) => other !== target))) {
    const people = known.filter((face) => key(face) === other);
    const otherScore = alikeness(samples, people);
    if (otherScore > score + LIKELIER_MARGIN && otherScore > (likelier?.score ?? 0)) likelier = { name: people[0]!.name.trim(), score: otherScore };
  }
  const farOff = score < FAR_OFF_SIMILARITY;
  return { score, farOff, likelier, ask: farOff || likelier !== null, threshold: MATCH_THRESHOLD };
}

/** The question before saving into `name`, when there is one. */
export function similarityQuestion(similarity: PersonSimilarity, name: string): string | null {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  if (similarity.farOff) return `These look like a different person: ${pct(similarity.score)}`;
  if (similarity.likelier) return `These look more like ${similarity.likelier.name} (${pct(similarity.likelier.score)}) than ${name} (${pct(similarity.score)})`;
  return null;
}

/** An uploaded photo for someone's samples: exactly one face, or the reason it can't be used. */
export function uploadVerdict(faceCount: number): { ok: true } | { ok: false; reason: string } {
  if (faceCount === 0) return { ok: false, reason: 'no face found' };
  if (faceCount > 1) return { ok: false, reason: `${faceCount} faces: use a photo of one person` };
  return { ok: true };
}
