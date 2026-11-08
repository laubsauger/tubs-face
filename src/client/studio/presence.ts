// The director's studio_presence, mapped onto what the camera reports on the
// operator face: how many people are in view (sleep and proactive lines
// follow it) and, after a long enough absence, that the visit is over.

import type { StudioActor } from '../../shared/contracts/studio.js';
import { FORGET_AFTER_MS } from '../face/visitor-tracker.js';

export interface StudioPresence {
  /** The director's update for one head. Returns the people in view of either head. */
  update(actor: StudioActor, present: boolean, people: number | undefined, now: number): number;
  /**
   * True once when nobody has been near either head for `forgetAfterMs`: the
   * visit is over (the camera path sends presence:false at the same point).
   */
  visitOver(now: number): boolean;
}

export function createStudioPresence(forgetAfterMs = FORGET_AFTER_MS): StudioPresence {
  const byActor = new Map<StudioActor, number>();
  let inVisit = false;
  let emptySince = 0;

  return {
    update(actor, present, people, now) {
      // present without a count is someone; a count without present is nobody.
      byActor.set(actor, present ? Math.max(1, Math.floor(people ?? 1)) : 0);
      // The two windows can see the same people, so the larger count, not the sum.
      const count = Math.max(0, ...byActor.values());
      if (count > 0) {
        inVisit = true;
        emptySince = 0;
      } else if (inVisit && !emptySince) {
        emptySince = now;
      }
      return count;
    },
    visitOver(now) {
      if (!inVisit || !emptySince || now - emptySince < forgetAfterMs) return false;
      inVisit = false;
      emptySince = 0;
      return true;
    },
  };
}
