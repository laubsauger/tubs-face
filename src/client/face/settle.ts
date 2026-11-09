// Names decided per track, not per frame. A single frame can rank the wrong
// person first by a hair (live: Rapha 0.715 over Flo 0.678, one frame, and Tubs
// greeted "Rapha" and kept tonight's notes under that name). So a face gets a
// name only once its track has matched that person on several checks, and
// keeps it (sticky) until another person has matched as often.
//
// Shared by the listener page (client/face/runtime.ts, the browser worker) and
// the server (server/faces/recognition.ts, the face service): both annotate a
// frame with annotateDetectedFaces (matching.ts: this frame's verdict, with the
// threshold and margin) and pass it through settle(), which keeps name and
// match only where the track's name has settled. Everything downstream (who is
// in view, greetings, relationships, field notes, the observation's decision)
// sees settled names only.
//
// A vote is a fresh embedding: the worker and the service reuse a tracked
// face's embedding for a while, and the same embedding twice is one piece of
// evidence, not two. _trackedAge 0 is fresh, above 0 reused; without it, a
// frame whose candidates and scores equal the track's last vote is the same one.

import type { DetectedFace, FaceBox } from '../../shared/contracts/faces.js';

export interface SettleOptions {
  /** A name settles once this many of the track's last `window` votes named it. */
  votes: number;
  window: number;
  /** One vote settles an unnamed track at once when it is this clear: best at least strongSim and strongLead over the runner-up. */
  strongSim: number;
  strongLead: number;
  /** A track not seen this long is gone (its face is a new track when it comes back). */
  forgetMs: number;
  /** Faces overlapping a track's last box this much (intersection over union) continue it, when the producer gives no track. */
  sameTrackIou: number;
}

/**
 * Calibrated on the studio library (src/scripts/face-library-audit.ts,
 * leave-one-session-out): no wrong best match led its runner-up by more than
 * 0.115, while the right ones led by 0.56 (median). 2 of 3 votes takes about
 * 1-2 s with the face service (a fresh embedding a second).
 */
export const SETTLE_DEFAULTS: SettleOptions = {
  votes: 2,
  window: 3,
  strongSim: 0.75,
  strongLead: 0.3,
  // Two missed checks of the listener page's worker (one every 5 s at most).
  forgetMs: 12_000,
  sameTrackIou: 0.3,
};

export type SettledFace<T extends DetectedFace> = T & {
  track: number;
  /** The name this track leads towards but has not settled on yet (it has votes, too few). */
  pending?: string;
};

interface TrackState {
  id: number;
  box: FaceBox;
  seenAt: number;
  /** This track's last votes, newest last: the name this frame accepted, or null. */
  votes: Array<string | null>;
  lastVoteKey: string;
  settled: string | null;
  settledScore: number;
}

export interface NameSettler {
  /** The frame's faces (annotateDetectedFaces), with name and match only where the track's name has settled. */
  settle<T extends DetectedFace & { track?: number }>(faces: T[], now: number): Array<SettledFace<T>>;
  /** The library changed: names settled against the old one are dropped. */
  reset(): void;
}

function iou(a: FaceBox, b: FaceBox): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const shared = width * height;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - shared;
  return union > 0 ? shared / union : 0;
}

/** What this frame's embedding said, to tell a reused embedding from a new one. */
function voteKey(face: DetectedFace): string {
  return (face.matches ?? []).map((match) => `${match.name}:${match.score.toFixed(5)}`).join('|');
}

export function createNameSettler(options: Partial<SettleOptions> = {}): NameSettler {
  const o: SettleOptions = { ...SETTLE_DEFAULTS, ...options };
  let tracks: TrackState[] = [];
  let nextId = 1;

  function trackFor(face: DetectedFace & { track?: number }, taken: Set<TrackState>, now: number): TrackState {
    if (typeof face.track === 'number') {
      const known = tracks.find((track) => track.id === face.track);
      if (known) return known;
      const created: TrackState = { id: face.track, box: face.box, seenAt: now, votes: [], lastVoteKey: '', settled: null, settledScore: 0 };
      tracks.push(created);
      return created;
    }
    let best: { track: TrackState; overlap: number } | null = null;
    for (const track of tracks) {
      if (taken.has(track)) continue;
      const overlap = iou(face.box, track.box);
      if (overlap >= o.sameTrackIou && (!best || overlap > best.overlap)) best = { track, overlap };
    }
    if (best) return best.track;
    const created: TrackState = { id: nextId++, box: face.box, seenAt: now, votes: [], lastVoteKey: '', settled: null, settledScore: 0 };
    tracks.push(created);
    return created;
  }

  return {
    settle(faces, now) {
      tracks = tracks.filter((track) => now - track.seenAt <= o.forgetMs);
      const taken = new Set<TrackState>();
      return faces.map((face) => {
        const track = trackFor(face, taken, now);
        taken.add(track);
        track.box = face.box;
        track.seenAt = now;

        const key = voteKey(face);
        const fresh = face._trackedAge !== undefined ? face._trackedAge === 0 : key !== track.lastVoteKey;
        const hasEmbedding = Array.isArray(face.embedding) && (face.matches?.length ?? 0) > 0;
        if (fresh && hasEmbedding) {
          track.lastVoteKey = key;
          const verdict = (face.match?.name ?? face.name ?? null) || null;
          track.votes.push(verdict);
          if (track.votes.length > o.window) track.votes.shift();
          const best = face.matches?.[0];
          const lead = best ? best.score - (face.matches?.[1]?.score ?? 0) : 0;
          const strong = Boolean(verdict && best && best.name === verdict && best.score >= o.strongSim && lead >= o.strongLead);
          const count = verdict ? track.votes.filter((vote) => vote === verdict).length : 0;
          // Settling an unnamed track: enough votes, or one very clear one. Renaming a named one: enough votes only.
          if (verdict && verdict !== track.settled && (count >= o.votes || (strong && track.settled === null))) {
            track.settled = verdict;
          }
          if (verdict && verdict === track.settled && best) track.settledScore = best.score;
        }

        const own = track.settled ? face.matches?.find((match) => match.name === track.settled) : undefined;
        const leader = track.votes.at(-1);
        const settled: SettledFace<typeof face> = {
          ...face,
          track: track.id,
          name: track.settled,
          match: track.settled ? { ...(own ?? { name: track.settled, score: track.settledScore }) } : null,
          ...(!track.settled && leader ? { pending: leader } : {}),
        };
        return settled;
      });
    },
    reset() {
      tracks = [];
    },
  };
}
