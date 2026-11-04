import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueueRun } from './queue-run.js';

// The queue's scripted pauses (Manual Beats delays, the gap between lines)
// must hold, while an interrupt has to end every wait immediately.
describe('createQueueRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cancel ends pauses and runs cancel handlers at once', async () => {
    const run = createQueueRun();
    const onCancel = vi.fn();
    run.onCancel(onCancel);
    let done = false;
    void run.pause(60_000).then(() => { done = true; });
    run.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(run.cancelled).toBe(true);
  });

  it('wake ends a wait for the other head but not a scripted pause', async () => {
    const run = createQueueRun();
    let scripted = false;
    let remote = false;
    void run.pause(1000).then(() => { scripted = true; });
    void run.pause(1000, { wakeable: true }).then(() => { remote = true; });
    run.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(remote).toBe(true);
    expect(scripted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scripted).toBe(true);
  });

  it('a cancelled run does not pause at all', async () => {
    const run = createQueueRun();
    run.cancel();
    let done = false;
    void run.pause(5000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });
});
