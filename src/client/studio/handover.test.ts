import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOVER_BREATH_MS, HANDOVER_MAX_WAIT_MS, createHandoverGate } from './handover.js';

// Two heads talk in turn. The answer starts a breath after the other head's
// line has played out on its own page: not on a guess at when it ends (350-650
// ms, and talking over a line that started late), and not stuck if that page
// never says so.

const line = { actor: 'main', turnId: 't1', text: 'You again.' };
const caption = (patch: Partial<{ actor: string; turnId: string; text: string; done: boolean }> = {}) => ({ ...line, done: true, ...patch });

describe('the handover between two heads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function gate() {
    return createHandoverGate({ now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number, clearTimer: (id) => clearTimeout(id) });
  }

  it('starts the answer a breath after the line it answers is done, not before', async () => {
    const handover = gate();
    let started = '';
    void handover.waitFor(line).then((how) => { started = how; });
    handover.noteCaption(caption({ done: false }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(started, 'still speaking').toBe('');
    handover.noteCaption(caption());
    await vi.advanceTimersByTimeAsync(HANDOVER_BREATH_MS - 1);
    expect(started).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe('done');
    // Ming's own head and tail silence plus the caption tick make up the rest of the pause.
    expect(HANDOVER_BREATH_MS).toBeLessThanOrEqual(150);
  });

  it('counts the breath from when the line ended, if the answer arrives late', async () => {
    const handover = gate();
    handover.noteCaption(caption());
    await vi.advanceTimersByTimeAsync(40);
    let started = '';
    void handover.waitFor(line).then((how) => { started = how; });
    await vi.advanceTimersByTimeAsync(HANDOVER_BREATH_MS - 40 - 1);
    expect(started).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe('done');
  });

  it('waits for that line only: another line, turn or head does not release it', async () => {
    const handover = gate();
    let started = '';
    void handover.waitFor(line).then((how) => { started = how; });
    handover.noteCaption(caption({ text: 'Something else.' }));
    handover.noteCaption(caption({ turnId: 't0' }));
    handover.noteCaption(caption({ actor: 'small' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe('');
  });

  // Live, the first line waited 2.5 s for its face, and its answer, capped at
  // 4 s from when it was ready, started over it.
  it('waits for the line however long, while the other head\'s page is alive', async () => {
    const handover = gate();
    let started = '';
    void handover.waitFor(line).then((how) => { started = how; });
    for (let second = 0; second < 10; second += 1) {
      handover.noteAlive('main'); // its heartbeat, once a second
      await vi.advanceTimersByTimeAsync(1000);
    }
    handover.noteCaption(caption({ done: false }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(started, 'still waiting, ten seconds on').toBe('');
    handover.noteCaption(caption());
    await vi.advanceTimersByTimeAsync(HANDOVER_BREATH_MS);
    expect(started).toBe('done');
  });

  it('starts anyway when the other head\'s page has gone silent', async () => {
    const handover = gate();
    let started = '';
    void handover.waitFor(line).then((how) => { started = how; });
    await vi.advanceTimersByTimeAsync(HANDOVER_MAX_WAIT_MS);
    expect(started).toBe('cap');
  });
});
