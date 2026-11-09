import { describe, expect, it } from 'vitest';
import type { Playback, SpokenItem, VoiceClock } from '../audio/voice-clock.js';
import { createCaptionTracker, type StudioCaptionState } from './caption.js';

// A window draws a head's caption under its face, the heard part bright. So
// the caption has to say how much was heard, step by step, and tell when each
// line is over: exactly once, or a window would fade a line twice or keep a
// finished one lit forever.

let clockNow = 0;
const items: SpokenItem[] = [];
let quietAt: number | null = null;
const voice = (): VoiceClock => ({ items, quietAt });

function say(text: string, turnId: string, seconds: number, at = clockNow, open = false): SpokenItem {
  const playback: Playback = { clock: () => clockNow, pieces: [{ at, seconds }] };
  const item: SpokenItem = { chars: text.length, startedAt: at * 1000, seconds, open, text, turnId, playback };
  items.push(item);
  quietAt = null;
  return item;
}

function run(tracker: ReturnType<typeof createCaptionTracker>, untilSeconds: number, step = 0.1): StudioCaptionState[] {
  const out: StudioCaptionState[] = [];
  for (; clockNow <= untilSeconds + 1e-9; clockNow = Math.round((clockNow + step) * 1000) / 1000) {
    out.push(...tracker.update(voice(), clockNow * 1000));
  }
  return out;
}

function fresh(): ReturnType<typeof createCaptionTracker> {
  items.length = 0;
  quietAt = null;
  clockNow = 0;
  const tracker = createCaptionTracker();
  tracker.update(voice(), 0);
  return tracker;
}

describe('studio captions', () => {
  it('report a line as it is heard, then done once, with all of it heard', () => {
    const tracker = fresh();
    say('Nice hat.', 't1', 1);
    const out = run(tracker, 2);
    const spoken = out.map((c) => c.spoken);
    expect(spoken).toEqual([...spoken].sort((a, b) => a - b));
    expect(out.filter((c) => c.done)).toEqual([{ turnId: 't1', text: 'Nice hat.', spoken: 9, done: true }]);
    expect(out.at(-1)?.done).toBe(true);
  });

  it('say nothing while nothing changes', () => {
    const tracker = fresh();
    say('Hmm.', 't1', 0.5);
    run(tracker, 1);
    expect(run(tracker, 5)).toEqual([]);
  });

  it('count a filler as its own line before the reply, each done once', () => {
    const tracker = fresh();
    say('Um, okay.', 't2', 0.6, 0);
    const first = run(tracker, 0.6);
    say('Did it come with instructions?', 't2', 1.5, 0.7);
    const rest = run(tracker, 3);
    const done = [...first, ...rest].filter((c) => c.done).map((c) => c.text);
    expect(done).toEqual(['Um, okay.', 'Did it come with instructions?']);
  });

  it('finish a line the moment the next one starts, if its end was not seen yet', () => {
    const tracker = fresh();
    say('One.', 't3', 0.4, 0);
    clockNow = 0.2;
    tracker.update(voice(), 200);
    say('Two.', 't3', 0.4, 0.4);
    clockNow = 0.45;
    const out = tracker.update(voice(), 450);
    expect(out[0]).toEqual({ turnId: 't3', text: 'One.', spoken: 4, done: true });
    expect(out[1]).toMatchObject({ text: 'Two.', done: false });
  });

  it('end a line that was cut off with what was heard by then', () => {
    const tracker = fresh();
    say('This is going to be a long and boring story.', 't4', 4);
    run(tracker, 1);
    quietAt = clockNow * 1000;
    const out = tracker.update(voice(), clockNow * 1000);
    expect(out).toHaveLength(1);
    expect(out[0]!.done).toBe(true);
    expect(out[0]!.spoken).toBeGreaterThan(0);
    expect(out[0]!.spoken).toBeLessThan(20);
    expect(run(tracker, 5)).toEqual([]);
  });

  it('do not report lines spoken before captions started', () => {
    items.length = 0;
    clockNow = 10;
    say('Old line.', 't0', 0.5, 0);
    const tracker = createCaptionTracker();
    expect(run(tracker, 12)).toEqual([]);
  });

  // Under load a window showed the start and the end of one Ming reply in
  // turn, several times a second: a stalled stream had ended the line, and its
  // late audio started the same text as a new line from the beginning.
  it('carry on one line through a stalled Ming stream: no second line, never backwards', () => {
    const tracker = fresh();
    const text = 'You walked up to a machine for validation. Your search history does that every single day.';
    // The first piece plays for 1 s, then the stream stalls and the same reply carries on in a new item.
    const first = say(text, 't9', 4, 0, true);
    const out = run(tracker, 1.6);
    say(text, 't9', 3, 1.6, true);
    out.push(...run(tracker, 3));
    first.open = false;
    items.at(-1)!.open = false;
    out.push(...run(tracker, 6));
    const spoken = out.map((caption) => caption.spoken);
    expect(spoken).toEqual([...spoken].sort((a, b) => a - b));
    expect(out.every((caption) => caption.text === text && caption.turnId === 't9')).toBe(true);
    expect(out.filter((caption) => caption.done)).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ done: true, spoken: text.length });
  });
});
