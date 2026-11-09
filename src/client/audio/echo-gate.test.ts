import { describe, expect, it } from 'vitest';
import { ECHO_BARGE_IN, createEchoBargeIn } from './echo-gate.js';

// With the voice playing in the room from somewhere else, the mic hears Tubs
// himself. Barge-in must never fire on that echo (he would cut himself off),
// yet a visitor clearly talking over him must still get through.

const FRAME_MS = 43; // one 2048-sample mic chunk at 48 kHz

/** Feeds `ms` of frames at levels from `level(t)`; true if barge-in fired. */
function run(gate: ReturnType<typeof createEchoBargeIn>, ms: number, level: (t: number) => number, start = 0): boolean {
  let fired = false;
  for (let t = start; t < start + ms; t += FRAME_MS) {
    fired = gate.feed(level(t), FRAME_MS) || fired;
  }
  return fired;
}

// Speech is not a steady level: syllables, pauses, stressed vowels.
const syllables = (base: number) => (t: number) => base * (0.3 + 1.7 * Math.abs(Math.sin(t / 90)));

describe('barge-in over the echo', () => {
  it('never fires on a head\'s own echo, however loud the room plays it', () => {
    for (const echo of [0.02, 0.08, 0.25]) {
      expect(run(createEchoBargeIn(), 8000, syllables(echo)), `echo ${echo}`).toBe(false);
    }
  });

  it('ignores the stream arriving late: silence first, then the echo', () => {
    const gate = createEchoBargeIn();
    expect(run(gate, 6000, (t) => (t < 400 ? 0 : syllables(0.12)(t)))).toBe(false);
  });

  it('fires when someone talks clearly over him for a moment', () => {
    const gate = createEchoBargeIn();
    expect(run(gate, 1500, syllables(0.03))).toBe(false);
    expect(run(gate, 700, () => 0.3, 1500)).toBe(true);
  });

  it('does not fire on a short shout or knock', () => {
    const gate = createEchoBargeIn();
    run(gate, 1500, syllables(0.03));
    expect(run(gate, ECHO_BARGE_IN.holdMs - 150, () => 0.4, 1500)).toBe(false);
    expect(run(gate, 2000, syllables(0.03), 1800)).toBe(false);
  });

  it('starts over with each line: the last line\'s loudness is no guide', () => {
    const gate = createEchoBargeIn();
    run(gate, 3000, syllables(0.25));
    gate.reset();
    // A quiet line now; a visitor at a level that was below the old echo still cuts in.
    expect(run(gate, 1500, syllables(0.02))).toBe(false);
    expect(run(gate, 700, () => 0.15, 1500)).toBe(true);
  });
});
