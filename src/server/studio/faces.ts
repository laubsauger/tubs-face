// The last FaceObservation (docs/face-service.md) from whichever producer
// runs: the listener page's browser worker today, the face service later.
// GET /studio/faces serves it; the pulse and the recognition part read it.

import type { FaceObservation } from '../../shared/contracts/studio.js';

/** An observation older than this says nothing about who is in view now. */
export const OBSERVATION_FRESH_MS = 10_000;

let last: { observation: FaceObservation; at: number } | null = null;

export function noteObservation(observation: FaceObservation, now = Date.now()): void {
  last = { observation, at: now };
}

/** The last observation and when it arrived; null before the first (or after the producer went away). */
export function lastObservation(): { observation: FaceObservation; at: number } | null {
  return last;
}

export function forgetObservation(): void {
  last = null;
}
