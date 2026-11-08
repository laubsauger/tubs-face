import { describe, expect, it } from 'vitest';
import { STAGE_WAIT_MAX_MS, createStageGate } from './stage.js';

// A head's voice should come from where its face is. While the director moves
// a face to another window a line waits for it, but never for long: a visitor
// waiting on silence is worse than a voice from the wrong place.

function clock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number; done: boolean }> = [];
  let id = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn, id: ++id, done: false }); return id; },
    clearTimer: (handle: unknown) => { const t = timers.find((entry) => entry.id === handle); if (t) t.done = true; },
    advance(ms: number) {
      now += ms;
      for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.fn(); }
    },
  };
}

describe('holding a line until the face is in place', () => {
  it('starts at once when no director moves the head', async () => {
    const gate = createStageGate(clock());
    await expect(gate.wait()).resolves.toBe('no-wait');
  });

  it('waits while the head travels, and starts when it is in place', async () => {
    const timers = clock();
    const gate = createStageGate(timers);
    gate.note(false);
    let started: string | null = null;
    void gate.wait().then((how) => { started = how; });
    timers.advance(1000);
    await Promise.resolve();
    expect(started).toBeNull();
    gate.note(true);
    await Promise.resolve();
    expect(started).toBe('ready');
  });

  it('starts at the cap when ready never comes', async () => {
    const timers = clock();
    const gate = createStageGate(timers);
    gate.note(false);
    let started: string | null = null;
    void gate.wait().then((how) => { started = how; });
    timers.advance(STAGE_WAIT_MAX_MS - 1);
    await Promise.resolve();
    expect(started).toBeNull();
    timers.advance(1);
    await Promise.resolve();
    expect(started).toBe('cap');
    expect(STAGE_WAIT_MAX_MS).toBe(2500);
  });

  it('does not wait again once the head is in place', async () => {
    const gate = createStageGate(clock());
    gate.note(false);
    gate.note(true);
    await expect(gate.wait()).resolves.toBe('no-wait');
  });
});
