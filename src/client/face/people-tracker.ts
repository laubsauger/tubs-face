import type { DetectedFace } from '../../shared/contracts/faces.js';
import { cosineSimilarity } from './matching.js';

/**
 * Each face in view as its own person: an id that stays theirs for the night
 * (field notes are kept by it), and where they stand. The visitor tracker
 * decides when a conversation starts and ends; this one tells Tubs who is in
 * a group and lets him side with one of them.
 *
 * Positions are as the camera sees them (the raw frame, not the mirrored
 * preview), the same frame the vision description is made from.
 */

export type PersonPosition = 'left' | 'center' | 'right';

export interface PersonInView {
  id: string;
  names: string[];
  position: PersonPosition;
  /** Seen earlier tonight and gone for this long; absent for someone new. */
  awayMs?: number;
}

/** A person in view with the face matched to them in this frame (stays on the client). */
export interface TrackedPerson extends PersonInView {
  face: DetectedFace;
}

/** Below this, a face is someone else. */
const SAME_PERSON_SIMILARITY = 0.5;
/** Out of view this long, a person leaves the group (they can still come back). */
const LEAVE_AFTER_MS = 8000;
const ARCHIVE_SIZE = 120;
const MAX_SAMPLES = 6;
const SAMPLE_EVERY_MS = 2000;

interface Person {
  id: string;
  names: Set<string>;
  samples: number[][];
  lastSampleAt: number;
  lastSeenAt: number;
  x: number;
  face: DetectedFace | null;
  /** When they came back from the archive, how long they had been gone. */
  awayMs?: number;
}

export interface PeopleTracker {
  /** Feed every detection; returns who is in view, left to right. */
  update(faces: DetectedFace[], frameWidth: number, now: number): TrackedPerson[];
}

export function createPeopleTracker(random: () => number = Math.random): PeopleTracker {
  const present = new Map<string, Person>();
  const archive: Person[] = [];
  const session = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  let nextId = 1;

  const nameOf = (face: DetectedFace) => (face.match?.name ?? face.name ?? '').trim();
  const embeddingOf = (face: DetectedFace) => (Array.isArray(face.embedding) && face.embedding.length > 0 ? face.embedding : null);

  /** 0..1 likeness of a face to a person (names count as certain). */
  function likeness(person: Person, face: DetectedFace): number {
    const name = nameOf(face);
    if (name && person.names.has(name)) return 1;
    const embedding = embeddingOf(face);
    if (!embedding || person.samples.length === 0) return 0;
    return Math.max(...person.samples.map((sample) => cosineSimilarity(sample, embedding)));
  }

  function remember(person: Person, face: DetectedFace, x: number, now: number): void {
    const name = nameOf(face);
    if (name) person.names.add(name);
    person.lastSeenAt = now;
    person.x = x;
    person.face = face;
    const embedding = embeddingOf(face);
    if (embedding && now - person.lastSampleAt >= SAMPLE_EVERY_MS) {
      person.lastSampleAt = now;
      person.samples.push(embedding);
      if (person.samples.length > MAX_SAMPLES) person.samples.shift();
    }
  }

  function positionOf(x: number, width: number): PersonPosition {
    const ratio = width > 0 ? x / width : 0.5;
    return ratio < 0.4 ? 'left' : ratio > 0.6 ? 'right' : 'center';
  }

  return {
    update(faces, frameWidth, now) {
      const unmatched = faces.map((face, index) => ({ face, index, x: (face.box[0] + face.box[2]) / 2 }));
      const claimed = new Set<string>();

      // Greedy: best face-person pairs first, among people already in view.
      const pairs: Array<{ person: Person; item: (typeof unmatched)[number]; score: number }> = [];
      for (const person of present.values()) {
        for (const item of unmatched) {
          const score = likeness(person, item.face);
          if (score >= SAME_PERSON_SIMILARITY) pairs.push({ person, item, score });
        }
      }
      pairs.sort((a, b) => b.score - a.score);
      const usedFaces = new Set<number>();
      for (const { person, item } of pairs) {
        if (claimed.has(person.id) || usedFaces.has(item.index)) continue;
        claimed.add(person.id);
        usedFaces.add(item.index);
        delete person.awayMs;
        remember(person, item.face, item.x, now);
      }

      for (const item of unmatched) {
        if (usedFaces.has(item.index)) continue;
        // No embedding to compare: with one person in view and one face, it is them.
        if (!embeddingOf(item.face) && !nameOf(item.face) && faces.length === 1 && present.size === 1) {
          const only = [...present.values()][0]!;
          claimed.add(only.id);
          remember(only, item.face, item.x, now);
          continue;
        }
        const pastIndex = archive.findIndex((past) => likeness(past, item.face) >= SAME_PERSON_SIMILARITY);
        let person: Person;
        if (pastIndex !== -1) {
          person = archive.splice(pastIndex, 1)[0]!;
          person.awayMs = now - person.lastSeenAt;
        } else {
          person = { id: `${session}-p${nextId++}`, names: new Set(), samples: [], lastSampleAt: -Infinity, lastSeenAt: now, x: item.x, face: null };
        }
        present.set(person.id, person);
        claimed.add(person.id);
        remember(person, item.face, item.x, now);
      }

      for (const person of [...present.values()]) {
        if (!claimed.has(person.id) && now - person.lastSeenAt >= LEAVE_AFTER_MS) {
          present.delete(person.id);
          delete person.awayMs;
          archive.unshift(person);
          if (archive.length > ARCHIVE_SIZE) archive.pop();
        }
      }

      return [...present.values()]
        .filter((person) => claimed.has(person.id))
        .sort((a, b) => a.x - b.x)
        .map((person) => ({
          id: person.id,
          names: [...person.names],
          position: positionOf(person.x, frameWidth),
          face: person.face!,
          ...(person.awayMs !== undefined ? { awayMs: person.awayMs } : {}),
        }));
    },
  };
}
