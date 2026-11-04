import type { DetectedFace } from '../../shared/contracts/faces.js';
import { cosineSimilarity } from './matching.js';

/**
 * Who is in front of Tubs, across short absences. A visitor who steps out of
 * view keeps their conversation; a different face, or nobody for a few
 * minutes, starts fresh. Strangers are told apart by face embedding, so this
 * works without enrollment.
 */

/** Nobody in view this long: the conversation is over. */
export const FORGET_AFTER_MS = 3 * 60_000;
/** Below this the face is someone else. Low on purpose: wrongly forgetting a
 * visitor mid-conversation is worse than keeping a stale one a bit longer. */
const SAME_VISITOR_SIMILARITY = 0.5;
/** A non-matching face must stay this long before it counts as a new visitor. */
const NEW_FACE_CONFIRM_MS = 3000;
/** Back after less than this, it was just a look away: no new greeting. */
export const RETURN_GREETING_MIN_AWAY_MS = 20_000;
/** Known visitor walking off mid-conversation gets called back on some visits. */
export const CALL_BACK_CHANCE = 0.4;
const CALL_BACK_MIN_DELAY_MS = 6000;
const CALL_BACK_MAX_DELAY_MS = 15_000;
const MAX_SAMPLES = 8;
const SAMPLE_EVERY_MS = 2000;
/** Past visitors remembered for the night, so someone back hours later is recognised. */
const ARCHIVE_SIZE = 60;

/**
 * Every visitor gets an id that stays theirs for the night (field notes are
 * kept by it). `awayMs` on arrived/new_visitor: a past visitor came back.
 */
export type VisitorEvent =
  | { type: 'arrived'; visitorId: string; names: string[]; awayMs?: number }
  | { type: 'new_visitor'; visitorId: string; names: string[]; awayMs?: number }
  | { type: 'returned'; visitorId: string; names: string[]; awayMs: number }
  | { type: 'call_back'; name: string }
  | { type: 'gone'; visitorId: string };

interface Visitor {
  id: string;
  lastSeenAt: number;
  samples: number[][];
  names: Set<string>;
  /** People-tracker ids seen during this visit. */
  personIds: Set<string>;
  lastSampleAt: number;
  absentSince: number;
  mismatchSince: number;
  callBackAt: number;
  calledBack: boolean;
}

export interface VisitorTracker {
  /**
   * Feed every detection result. `inConversation`: someone talked with Tubs
   * just now. `personIds`: the people tracker's ids for the faces in view.
   */
  update(faces: DetectedFace[], now: number, inConversation: boolean, personIds?: string[]): VisitorEvent[];
}

export function createVisitorTracker(random: () => number = Math.random): VisitorTracker {
  let visitor: Visitor | null = null;
  const archive: Visitor[] = [];
  // Unique per page load: after a reload the archive is gone, and old ids
  // must not pick up someone else's notes on the server.
  const session = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  let nextId = 1;

  function namesOf(faces: DetectedFace[]): string[] {
    return [...new Set(faces.map((face) => (face.match?.name ?? face.name ?? '').trim()).filter(Boolean))];
  }

  function embeddingsOf(faces: DetectedFace[]): number[][] {
    return faces.map((face) => face.embedding).filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0);
  }

  /** A past visitor if this face is one, otherwise someone new. */
  function startVisitor(faces: DetectedFace[], personIds: string[], now: number): { next: Visitor; awayMs?: number } {
    const index = archive.findIndex((past) => isSameVisitor(past, faces, personIds) === true);
    if (index !== -1) {
      const [past] = archive.splice(index, 1);
      const awayMs = now - past!.lastSeenAt;
      Object.assign(past!, { lastSeenAt: now, absentSince: 0, mismatchSince: 0, callBackAt: 0, calledBack: false });
      remember(past!, faces, personIds, now);
      return { next: past!, awayMs };
    }
    return {
      next: { id: `${session}-${nextId++}`, lastSeenAt: now, samples: embeddingsOf(faces).slice(0, MAX_SAMPLES), names: new Set(namesOf(faces)), personIds: new Set(personIds), lastSampleAt: now, absentSince: 0, mismatchSince: 0, callBackAt: 0, calledBack: false },
    };
  }

  function archiveVisitor(past: Visitor): void {
    archive.unshift(past);
    if (archive.length > ARCHIVE_SIZE) archive.pop();
  }

  /** null when there is nothing to compare (no embeddings on one side). */
  function isSameVisitor(current: Visitor, faces: DetectedFace[], personIds: string[]): boolean | null {
    // The people tracker follows a face by position when recognition misses it.
    if (personIds.some((id) => current.personIds.has(id))) return true;
    const names = namesOf(faces);
    if (names.some((name) => current.names.has(name))) return true;
    const embeddings = embeddingsOf(faces);
    if (embeddings.length === 0 || current.samples.length === 0) return null;
    return embeddings.some((embedding) => current.samples.some((sample) => cosineSimilarity(sample, embedding) >= SAME_VISITOR_SIMILARITY));
  }

  function remember(current: Visitor, faces: DetectedFace[], personIds: string[], now: number): void {
    for (const name of namesOf(faces)) current.names.add(name);
    for (const id of personIds) current.personIds.add(id);
    if (now - current.lastSampleAt < SAMPLE_EVERY_MS) return;
    current.lastSampleAt = now;
    current.samples.push(...embeddingsOf(faces));
    if (current.samples.length > MAX_SAMPLES) current.samples.splice(0, current.samples.length - MAX_SAMPLES);
  }

  return {
    update(faces, now, inConversation, personIds = []) {
      if (faces.length > 0) {
        if (!visitor) {
          const { next, awayMs } = startVisitor(faces, personIds, now);
          visitor = next;
          return [{ type: 'arrived', visitorId: next.id, names: [...next.names], ...(awayMs !== undefined ? { awayMs } : {}) }];
        }
        const same = isSameVisitor(visitor, faces, personIds);
        const wasAway = visitor.absentSince > 0;
        if (same === false) {
          visitor.mismatchSince ||= now;
          // Back from an absence as someone else, or a stranger has stood
          // there a few seconds with the old visitor nowhere in view.
          if (wasAway || now - visitor.mismatchSince >= NEW_FACE_CONFIRM_MS) {
            archiveVisitor(visitor);
            const { next, awayMs } = startVisitor(faces, personIds, now);
            visitor = next;
            return [{ type: 'new_visitor', visitorId: next.id, names: [...next.names], ...(awayMs !== undefined ? { awayMs } : {}) }];
          }
          return [];
        }
        visitor.mismatchSince = 0;
        visitor.lastSeenAt = now;
        remember(visitor, faces, personIds, now);
        if (wasAway) {
          const awayMs = now - visitor.absentSince;
          visitor.absentSince = 0;
          visitor.callBackAt = 0;
          return [{ type: 'returned', visitorId: visitor.id, names: [...visitor.names], awayMs }];
        }
        return [];
      }

      if (!visitor) return [];
      if (!visitor.absentSince) {
        visitor.absentSince = now;
        // Decide now whether this departure gets a call back, and when.
        const name = [...visitor.names][0];
        // At most once per visit, so a pacing visitor is not chased around.
        visitor.callBackAt = name && inConversation && !visitor.calledBack && random() < CALL_BACK_CHANCE
          ? now + CALL_BACK_MIN_DELAY_MS + random() * (CALL_BACK_MAX_DELAY_MS - CALL_BACK_MIN_DELAY_MS)
          : 0;
      }
      if (now - visitor.absentSince >= FORGET_AFTER_MS) {
        const gone = visitor;
        archiveVisitor(gone);
        visitor = null;
        return [{ type: 'gone', visitorId: gone.id }];
      }
      if (visitor.callBackAt && now >= visitor.callBackAt) {
        visitor.callBackAt = 0;
        visitor.calledBack = true;
        return [{ type: 'call_back', name: [...visitor.names][0]! }];
      }
      return [];
    },
  };
}
