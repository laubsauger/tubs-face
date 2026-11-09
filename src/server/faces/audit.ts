// Which face library samples look like someone else (the memory view's flags,
// GET /memory/library/audit, src/scripts/face-library-audit.ts). A sample that
// reaches the match threshold against another person's sample can name that
// person's face as its owner (live: one of Rapha's samples, nearest to Flo's,
// named Flo "Rapha"); one that resembles none of its owner's other samples is
// probably not them. Computed here, on the server: the embeddings never leave it.

import { statSync } from 'node:fs';
import type { EnrolledFace } from '../../shared/contracts/faces.js';
import { cosineSimilarity, MATCH_THRESHOLD } from '../../client/face/matching.js';
import { faceLibraryPath, readFaceLibrary } from './library.js';

/** No other sample of its owner reaches this: "unlike their others". */
export const UNLIKE_OWN_BELOW = 0.35;

export interface SampleAudit {
  id: string;
  name: string;
  /** Its place among its owner's samples, oldest first (1-based), as the memory view and the audit script number them. */
  index: number;
  at: number | null;
  /** The most similar of its owner's other samples; null for someone with one sample. */
  nearestOwn: number | null;
  /** The person (other than its owner) with the most similar sample, and that similarity. */
  like: { name: string; sim: number } | null;
  flags: {
    /** like, when it reaches the match threshold: this sample can name that person's face. */
    looksLike: { name: string; sim: number } | null;
    /** None of its owner's other samples is even this alike. */
    unlikeOwn: boolean;
  };
}

const personKey = (name: string) => name.trim().toLowerCase();

export function auditSamples(faces: readonly EnrolledFace[]): SampleAudit[] {
  const byPerson = new Map<string, EnrolledFace[]>();
  for (const face of faces) byPerson.set(personKey(face.name), [...(byPerson.get(personKey(face.name)) ?? []), face]);
  const index = new Map<string, number>();
  for (const samples of byPerson.values()) {
    // Oldest first; samples of the same moment keep the library's order.
    [...samples].sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity)).forEach((face, i) => index.set(face.id, i + 1));
  }
  return faces.map((face) => {
    let nearestOwn: number | null = null;
    const likeByPerson = new Map<string, { name: string; sim: number }>();
    for (const other of faces) {
      if (other === face) continue;
      const sim = cosineSimilarity(face.embedding, other.embedding);
      if (personKey(other.name) === personKey(face.name)) {
        nearestOwn = nearestOwn === null ? sim : Math.max(nearestOwn, sim);
        continue;
      }
      const known = likeByPerson.get(personKey(other.name));
      if (!known || sim > known.sim) likeByPerson.set(personKey(other.name), { name: other.name, sim });
    }
    const like = [...likeByPerson.values()].sort((a, b) => b.sim - a.sim)[0] ?? null;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const rounded = like ? { name: like.name, sim: round(like.sim) } : null;
    return {
      id: face.id,
      name: face.name,
      index: index.get(face.id) ?? 0,
      at: face.createdAt ?? null,
      nearestOwn: nearestOwn === null ? null : round(nearestOwn),
      like: rounded,
      flags: {
        looksLike: like && like.sim >= MATCH_THRESHOLD ? rounded : null,
        unlikeOwn: nearestOwn !== null && nearestOwn < UNLIKE_OWN_BELOW,
      },
    };
  });
}

let cache: { mtimeMs: number; size: number; audit: SampleAudit[] } | null = null;

/** The audit of the library on disk, computed again only when the file changed (the memory view polls). */
export function currentAudit(): SampleAudit[] {
  let stamp = { mtimeMs: -1, size: -1 };
  try {
    const stat = statSync(faceLibraryPath);
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    // no library yet
  }
  if (!cache || cache.mtimeMs !== stamp.mtimeMs || cache.size !== stamp.size) cache = { ...stamp, audit: auditSamples(readFaceLibrary().faces) };
  return cache.audit;
}
