import { describe, expect, it } from 'vitest';
import { spokenShare, type Playback, type SpokenItem } from './voice-clock.js';

// What has been said must come from the audio that actually played: captions
// and the transcript light up words as they are heard. A stream that stalls
// (the next piece late) or a paused context must hold them, where wall time
// would run on and light words nobody has heard yet.

/** An item playing on a fake AudioContext clock the test moves by hand. */
function playing(pieces: Array<{ at: number; seconds: number }>, seconds: number, open: boolean): { item: SpokenItem; setClock: (t: number) => void } {
  let clock = 0;
  const playback: Playback = { clock: () => clock, pieces };
  return {
    item: { chars: 40, startedAt: 0, seconds, open, text: 'x'.repeat(40), playback },
    setClock: (t) => { clock = t; },
  };
}

describe('spoken share from playback', () => {
  it('follows the audio as it plays and reaches the end exactly with it', () => {
    const { item, setClock } = playing([{ at: 10, seconds: 2 }], 2, false);
    setClock(10);
    expect(spokenShare(item, 0)).toBe(0);
    setClock(11);
    expect(spokenShare(item, 99_999)).toBeCloseTo(0.5);
    setClock(12.5);
    expect(spokenShare(item, 0)).toBe(1);
  });

  it('holds while the stream stalls: the next piece has not arrived, so nothing more is heard', () => {
    // A streamed reply estimated at 4 s; its first 1 s piece has played, the next is late.
    const pieces = [{ at: 0, seconds: 1 }];
    const { item, setClock } = playing(pieces, 4, true);
    setClock(1);
    const atStall = spokenShare(item, 1000);
    setClock(3); // two seconds of silence later
    expect(spokenShare(item, 3000)).toBe(atStall);
    expect(atStall).toBeCloseTo(0.25);
    // The late piece arrives and plays after the gap.
    pieces.push({ at: 3, seconds: 1 });
    setClock(3.5);
    expect(spokenShare(item, 3500)).toBeCloseTo(0.375);
  });

  it('holds while playback is paused, however much wall time passes', () => {
    const { item, setClock } = playing([{ at: 0, seconds: 2 }], 2, false);
    setClock(0.5);
    const paused = spokenShare(item, 500);
    expect(spokenShare(item, 60_000)).toBe(paused);
  });

  it('keeps the last bit back while more audio is coming', () => {
    const { item, setClock } = playing([{ at: 0, seconds: 3 }], 3, true);
    setClock(10);
    expect(spokenShare(item, 10_000)).toBeLessThan(1);
  });

  it('falls back to wall time for speech without a playback clock', () => {
    const item: SpokenItem = { chars: 10, startedAt: 1000, seconds: 2, open: false };
    expect(spokenShare(item, 2000)).toBeCloseTo(0.5);
  });
});
