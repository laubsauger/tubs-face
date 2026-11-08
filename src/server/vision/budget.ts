// The vision budget, whatever the provider (docs/vision.md section 2). Vision
// is one of the main running costs: one camera is ~120 calls an hour while
// someone is around. A new visitor gets one look at once; the periodic
// refresh is skipped while Tubs sleeps; everything stops at the hourly cap.

export type VisionPictureKind = 'appearance' | 'refresh';
export type VisionSkip = 'off' | 'asleep' | 'cap';

export interface VisionBudgetRules {
  maxPerHour: number;
  whileAsleep: boolean;
}

export interface VisionBudget {
  /** Whether this picture may go to the provider now; a yes counts against the cap. */
  admit(kind: VisionPictureKind, rules: VisionBudgetRules & { off: boolean; sleeping: boolean }): { ok: true } | { ok: false; reason: VisionSkip };
  /** Calls in the last hour. */
  usedThisHour(): number;
}

const HOUR_MS = 60 * 60_000;

export function createVisionBudget(options: { now?: () => number; log?: (message: string) => void } = {}): VisionBudget {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(`[Vision] ${message}`));
  const calls: number[] = [];
  // The last skip reason logged, so a skip is logged once, not per frame.
  let lastSkip: VisionSkip | null = null;

  function prune(at: number): void {
    while (calls.length > 0 && calls[0]! <= at - HOUR_MS) calls.shift();
  }

  function skip(reason: VisionSkip, detail: string): { ok: false; reason: VisionSkip } {
    if (lastSkip !== reason) {
      lastSkip = reason;
      log(detail);
    }
    return { ok: false, reason };
  }

  return {
    admit(kind, rules) {
      const at = now();
      prune(at);
      if (rules.off) return skip('off', 'provider off: no pictures go anywhere');
      if (kind === 'refresh' && rules.sleeping && !rules.whileAsleep) return skip('asleep', 'refreshes paused while Tubs sleeps');
      if (calls.length >= Math.max(0, rules.maxPerHour)) {
        return skip('cap', `hourly cap of ${rules.maxPerHour} reached; no more pictures until the oldest call is an hour old`);
      }
      if (lastSkip) {
        log(`pictures go to the provider again (was: ${lastSkip})`);
        lastSkip = null;
      }
      calls.push(at);
      return { ok: true };
    },
    usedThisHour() {
      prune(now());
      return calls.length;
    },
  };
}
