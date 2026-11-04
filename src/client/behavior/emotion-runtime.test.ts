import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, AppStore } from '../state/app-state.js';
import { IDLE_SETTLE_MS, createEmotionRuntime, moodExpression } from './emotion-runtime.js';

// The face should carry how the last replies felt, for a while: an insulted
// Tubs stays grumpy for a bit instead of snapping back to neutral at once.

// Impulses as the server sends them (emotion.ts).
const ANNOYED = { pos: 0.24, neg: 0.56, arousal: 0.82 };
const SMUG = { pos: 0.5, neg: 0.16, arousal: 0.48 };
const DELIGHTED = { pos: 0.9, neg: 0.02, arousal: 0.78 };
const SAD = { pos: 0.12, neg: 0.82, arousal: 0.42 };

describe('mood', () => {
  let frames: Array<(now: number) => void>;
  let clock: number;
  let state: AppState;

  beforeEach(() => {
    frames = [];
    clock = 1_000_000;
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    state = { sleeping: false, audioPlaying: false, currentExpression: 'idle', moodPos: 0, moodNeg: 0, moodArousal: 0 } as unknown as AppState;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function runtimeWithStore() {
    const store = {
      getState: () => state,
      setState: (updater: (s: AppState) => AppState) => { state = updater(state); },
    } as unknown as AppStore;
    const runtime = createEmotionRuntime(store);
    runtime.init();
    return runtime;
  }

  /** Advances the animation loop in 50 ms frames. */
  function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      clock += 50;
      const frame = frames.shift();
      frame?.(clock);
    }
  }

  const mood = () => ({ pos: state.moodPos, neg: state.moodNeg, arousal: state.moodArousal });

  it('one annoyed reply shows as anger, then fades within half a minute', () => {
    const runtime = runtimeWithStore();
    runtime.pushImpulse(ANNOYED, 'spoken');
    advance(3000);
    expect(moodExpression(mood())).toBe('angry');
    advance(30_000);
    expect(moodExpression(mood())).toBeNull();
  });

  it('a run of insults stays angry far longer than one', () => {
    const once = runtimeWithStore();
    once.pushImpulse(ANNOYED, 'spoken');
    advance(15_000);
    const afterOne = moodExpression(mood());

    once.dispose();
    frames = [];
    state = { ...state, moodPos: 0, moodNeg: 0, moodArousal: 0 };
    const thrice = runtimeWithStore();
    thrice.pushImpulse(ANNOYED, 'spoken');
    thrice.pushImpulse(ANNOYED, 'spoken');
    thrice.pushImpulse(ANNOYED, 'spoken');
    advance(15_000);
    expect(afterOne).toBeNull();
    expect(moodExpression(mood())).toBe('angry');
  });

  it('each emoji leaves its own idle face', () => {
    const faces = [SMUG, DELIGHTED, SAD].map((impulse) => {
      state = { ...state, moodPos: 0, moodNeg: 0, moodArousal: 0 };
      frames = [];
      const runtime = runtimeWithStore();
      runtime.pushImpulse(impulse, 'spoken');
      advance(2000);
      return moodExpression(mood());
    });
    expect(faces).toEqual(['smug', 'happy', 'sad']);
  });
});

// A lingering mood used to flip the face every few seconds, and the moment a
// reply ended it jumped straight into the next face. It should show now and
// then, hold long enough to read, and let the face rest at idle in between.
describe('mood on the idle face', () => {
  let frames: Array<(now: number) => void>;
  let clock: number;
  let state: AppState;

  beforeEach(() => {
    frames = [];
    clock = 1_000_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    state = { sleeping: false, audioPlaying: false, currentExpression: 'idle', moodPos: 0, moodNeg: 0, moodArousal: 0 } as unknown as AppState;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function delighted() {
    const store = {
      getState: () => state,
      setState: (updater: (s: AppState) => AppState) => { state = updater(state); },
    } as unknown as AppStore;
    const runtime = createEmotionRuntime(store);
    runtime.init();
    for (let i = 0; i < 4; i += 1) runtime.pushImpulse(DELIGHTED, 'spoken');
    return runtime;
  }

  /** Runs frames and timers in 50 ms steps, recording the expression shown. */
  function record(ms: number): string[] {
    const shown: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      clock += 50;
      vi.advanceTimersByTime(50);
      frames.shift()?.(clock);
      shown.push(state.currentExpression);
    }
    return shown;
  }

  /** Runs of the same expression, as [expression, duration ms]. */
  function runs(shown: string[]): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const expression of shown) {
      const last = out.at(-1);
      if (last && last[0] === expression) last[1] += 50;
      else out.push([expression, 50]);
    }
    return out;
  }

  it('shows a strong mood now and then, held long enough to read, with rests in between', () => {
    delighted();
    const pulses = runs(record(60_000));
    const shown = pulses.filter(([expression]) => expression !== 'idle');
    expect(shown.length).toBeGreaterThanOrEqual(2);
    // Never more often than every ~8 s.
    let at = 0;
    const starts: number[] = [];
    for (const [expression, ms] of pulses) {
      if (expression !== 'idle') starts.push(at);
      at += ms;
    }
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(8000);
    // The last run may be cut off by the end of the recording.
    for (const [, ms] of shown.slice(0, -1)) expect(ms).toBeGreaterThanOrEqual(2000);
    for (const [, ms] of pulses.filter(([expression]) => expression === 'idle').slice(1, -1)) {
      expect(ms).toBeGreaterThanOrEqual(IDLE_SETTLE_MS);
    }
  });

  it('after a reply ends, the face rests at idle before the mood shows again', () => {
    delighted();
    state = { ...state, currentExpression: 'happy' };
    record(3000);
    state = { ...state, currentExpression: 'idle' };
    const afterwards = record(IDLE_SETTLE_MS - 100);
    expect(afterwards.every((expression) => expression === 'idle')).toBe(true);
  });
});
