/**
 * One pass over the speech queue. Every pause the pass is in, and every wait
 * registered with onCancel, ends the moment the pass is cancelled (interrupt,
 * stop), so nothing from an interrupted item can release the queue later.
 */
export interface QueueRun {
  readonly cancelled: boolean;
  /**
   * Resolves after `ms`, or at once if the run is cancelled. A wakeable pause
   * (waiting for the other head) also ends on wake(); scripted pauses do not,
   * so their timing holds when new lines are queued.
   */
  pause(ms: number, options?: { wakeable?: boolean }): Promise<void>;
  /** Re-check now: ends wakeable pauses early. */
  wake(): void;
  cancel(): void;
  /** Called on cancel (immediately if already cancelled). */
  onCancel(handler: () => void): void;
}

export function createQueueRun(): QueueRun {
  let cancelled = false;
  const pauses = new Map<() => void, boolean>();
  const cancelHandlers = new Set<() => void>();

  return {
    get cancelled() {
      return cancelled;
    },
    pause(ms, options = {}) {
      if (cancelled) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const finish = () => {
          window.clearTimeout(timer);
          pauses.delete(finish);
          resolve();
        };
        const timer = window.setTimeout(finish, ms);
        pauses.set(finish, options.wakeable === true);
      });
    },
    wake() {
      for (const [finish, wakeable] of [...pauses]) {
        if (wakeable) finish();
      }
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const finish of [...pauses.keys()]) finish();
      for (const handler of [...cancelHandlers]) handler();
      cancelHandlers.clear();
    },
    onCancel(handler) {
      if (cancelled) {
        handler();
        return;
      }
      cancelHandlers.add(handler);
    },
  };
}
