// The face library as people and their capture sessions, for the library
// dialog: one block per person; inside, the samples taken together (an
// onboarding's poses, a few seconds apart) as one row. The library stores no
// session, so a session is derived from the timestamps: samples less than
// SESSION_GAP_MS apart belong together. Samples without a time form their own
// "undated" session.

import type { EnrolledFace } from '../../shared/contracts/faces.js';

/** Samples closer than this in time were taken in the same sitting. */
export const SESSION_GAP_MS = 5 * 60_000;
/** People with more samples than this start folded. */
export const FOLD_OVER_SAMPLES = 12;

export interface LibrarySession {
  key: string;
  /** When its first sample was taken; null for samples without a time. */
  startedAt: number | null;
  faces: EnrolledFace[];
}

export interface LibraryPerson {
  key: string;
  name: string;
  samples: number;
  /** The newest sample's time (the library keeps no "last seen"). */
  lastSampleAt: number | null;
  /** Newest first. */
  sessions: LibrarySession[];
  foldedByDefault: boolean;
}

const personKey = (name: string) => name.trim().toLowerCase();

export function groupLibrary(faces: readonly EnrolledFace[]): LibraryPerson[] {
  const people = new Map<string, { name: string; faces: EnrolledFace[] }>();
  for (const face of faces) {
    const key = personKey(face.name) || face.id;
    const person = people.get(key) ?? { name: face.name.trim() || 'Unnamed', faces: [] };
    person.faces.push(face);
    people.set(key, person);
  }
  return [...people.entries()]
    .map(([key, person]) => {
      const dated = person.faces.filter((face) => typeof face.createdAt === 'number').sort((a, b) => a.createdAt! - b.createdAt!);
      const sessions: LibrarySession[] = [];
      for (const face of dated) {
        const current = sessions.at(-1);
        const previous = current?.faces.at(-1);
        if (current && previous && face.createdAt! - previous.createdAt! < SESSION_GAP_MS) current.faces.push(face);
        else sessions.push({ key: `${key}:${face.createdAt}`, startedAt: face.createdAt!, faces: [face] });
      }
      const undated = person.faces.filter((face) => typeof face.createdAt !== 'number');
      if (undated.length > 0) sessions.push({ key: `${key}:undated`, startedAt: null, faces: undated });
      return {
        key,
        name: person.name,
        samples: person.faces.length,
        lastSampleAt: dated.at(-1)?.createdAt ?? null,
        sessions: sessions.sort((a, b) => (b.startedAt ?? -1) - (a.startedAt ?? -1)),
        foldedByDefault: person.faces.length > FOLD_OVER_SAMPLES,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
