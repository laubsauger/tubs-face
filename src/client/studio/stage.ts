// Hold a line until the face is in place. In the studio the director may move
// a head to another window before it speaks (to the person it addresses); its
// voice should come from where its face is. The director says studio_stage
// {actor, ready:false} when the head sets off and {ready:true} once it is
// there. A line waits for that, never longer than STAGE_WAIT_MAX_MS. Fillers
// and call-outs don't wait: they cover the journey.

/** The longest a line waits for its face to arrive. */
export const STAGE_WAIT_MAX_MS = 2500;

export type StageWait = 'ready' | 'cap' | 'no-wait';

export interface StageGate {
  /** The director's studio_stage for this head. */
  note(ready: boolean): void;
  /** Resolves when a line may start: at once when the head is in place (or no director moves it). */
  wait(): Promise<StageWait>;
  dispose(): void;
}

export function createStageGate(options: {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  capMs?: number;
} = {}): StageGate {
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  const capMs = options.capMs ?? STAGE_WAIT_MAX_MS;
  // Unknown (no director, or one that never moves heads) counts as in place.
  let inPlace = true;
  const waiting = new Set<{ resolve: (how: StageWait) => void; timer: unknown }>();

  const release = (how: StageWait) => {
    for (const entry of waiting) {
      clearTimer(entry.timer);
      entry.resolve(how);
    }
    waiting.clear();
  };

  return {
    note(ready) {
      inPlace = ready;
      if (ready) release('ready');
    },
    wait() {
      if (inPlace) return Promise.resolve('no-wait');
      return new Promise<StageWait>((resolve) => {
        const entry = {
          resolve,
          timer: setTimer(() => {
            waiting.delete(entry);
            resolve('cap');
          }, capMs),
        };
        waiting.add(entry);
      });
    },
    dispose() {
      release('no-wait');
    },
  };
}
