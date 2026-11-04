import type { DetectedFace } from '../../shared/contracts/faces.js';
import { cosineSimilarity } from './matching.js';

/**
 * Auto onboarding: snapshots of unnamed people, taken while they talk with
 * Tubs, ready for the moment they tell him their name. Memory only until then.
 */

export const AUTO_ENROLL_SNAPSHOTS = 3;
export const AUTO_ENROLL_SNAPSHOT_EVERY_MS = 4000;
/** Face height as a share of the frame: smaller faces make poor samples. */
export const AUTO_ENROLL_MIN_FACE_HEIGHT = 0.15;
/** Nearly identical to a snapshot already taken: adds nothing to recognition. */
const DUPLICATE_SIMILARITY = 0.95;

export interface Snapshot {
  embedding: number[];
  thumbnail: string;
  at: number;
}

/** Whether this frame's face of an unnamed person is worth keeping as a snapshot. */
export function wantsSnapshot(person: { names: string[]; face: DetectedFace }, taken: readonly Snapshot[], now: number, frameHeight: number): boolean {
  const embedding = person.face.embedding;
  if (person.names.length > 0 || !Array.isArray(embedding) || embedding.length === 0) return false;
  if (taken.length >= AUTO_ENROLL_SNAPSHOTS) return false;
  if (now - (taken.at(-1)?.at ?? -Infinity) < AUTO_ENROLL_SNAPSHOT_EVERY_MS) return false;
  const [, y1, , y2] = person.face.box;
  if (!frameHeight || (y2 - y1) / frameHeight < AUTO_ENROLL_MIN_FACE_HEIGHT) return false;
  return !taken.some((sample) => cosineSimilarity(sample.embedding, embedding) >= DUPLICATE_SIMILARITY);
}
