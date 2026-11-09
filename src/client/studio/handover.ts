// Two heads in conversation: a head's line that answers the other head's line
// starts a breath after that line has actually played out on the other face
// page (its studio_caption says done). The server sends it ahead (studio
// mode), so it is decoded and waiting. Timed by the server alone, the pause
// was 350-650 ms, and a line held on its page made the other head talk over it.

/**
 * Short on purpose: the caption says done up to 100 ms after the audio ends,
 * and Ming's lines end and start with a little silence of their own. With 250
 * ms here the pause heard live was ~520 ms; the target is 250-450.
 */
export const HANDOVER_BREATH_MS = 60;
/**
 * The other page may be gone: start anyway once it has been silent (no
 * studio_state heartbeat, no caption) this long. While it is alive its line is
 * waited for to the end, however long that takes (it may itself be waiting for
 * its face, or for the line before it), up to HANDOVER_LONGEST_MS.
 */
export const HANDOVER_MAX_WAIT_MS = 4000;
export const HANDOVER_LONGEST_MS = 30_000;
const REMEMBER_LINES = 32;

export interface HandoverCaption {
  actor: string;
  turnId: string;
  text: string;
  done: boolean;
}

export interface HandoverGate {
  /** Every studio_caption, from either head. */
  noteCaption(caption: HandoverCaption): void;
  /** A head's page is alive (its studio_state heartbeat). */
  noteAlive(actor: string): void;
  /** Resolves a breath after that line was done (at once if it was long enough ago), or at the cap. */
  waitFor(line: { actor: string; turnId: string; text: string }): Promise<'done' | 'cap'>;
  dispose(): void;
}

export function createHandoverGate(options: {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  breathMs?: number;
  maxWaitMs?: number;
} = {}): HandoverGate {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => window.clearTimeout(id));
  const breathMs = options.breathMs ?? HANDOVER_BREATH_MS;
  const maxWaitMs = options.maxWaitMs ?? HANDOVER_MAX_WAIT_MS;
  // When each line was done, by "actor|turnId|text", and when each head's page last showed it is alive.
  const doneAt = new Map<string, number>();
  const aliveAt = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();
  const timers = new Set<number>();
  const key = (line: { actor: string; turnId: string; text: string }) => `${line.actor}|${line.turnId}|${line.text.trim()}`;

  const later = (fn: () => void, ms: number) => {
    const id = setTimer(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };

  return {
    noteAlive(actor) {
      aliveAt.set(actor, now());
    },
    noteCaption(caption) {
      const lineKey = key(caption);
      aliveAt.set(caption.actor, now());
      if (!caption.done) return;
      if (!doneAt.has(lineKey)) doneAt.set(lineKey, now());
      if (doneAt.size > REMEMBER_LINES) doneAt.delete(doneAt.keys().next().value!);
      for (const wake of waiting.get(lineKey)?.splice(0) ?? []) wake();
      waiting.delete(lineKey);
    },
    waitFor(line) {
      const lineKey = key(line);
      return new Promise((resolve) => {
        let settled = false;
        let cap = 0;
        const settle = (how: 'done' | 'cap') => {
          if (settled) return;
          settled = true;
          clearTimer(cap);
          resolve(how);
        };
        const afterDone = () => {
          const since = now() - (doneAt.get(lineKey) ?? now());
          later(() => settle('done'), Math.max(0, breathMs - since));
        };
        const startedAt = now();
        const check = () => {
          const silentFor = now() - (aliveAt.get(line.actor) ?? Number.NEGATIVE_INFINITY);
          if (silentFor >= maxWaitMs || now() - startedAt >= HANDOVER_LONGEST_MS) settle('cap');
          else cap = later(check, Math.min(maxWaitMs, Math.max(1, HANDOVER_LONGEST_MS - (now() - startedAt))));
        };
        cap = later(check, maxWaitMs);
        if (doneAt.has(lineKey)) {
          afterDone();
          return;
        }
        waiting.set(lineKey, [...(waiting.get(lineKey) ?? []), afterDone]);
      });
    },
    dispose() {
      for (const id of timers) clearTimer(id);
      timers.clear();
      waiting.clear();
    },
  };
}
