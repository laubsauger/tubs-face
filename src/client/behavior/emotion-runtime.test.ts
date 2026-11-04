import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, AppStore } from '../state/app-state.js';
import { createEmotionRuntime, moodExpression } from './emotion-runtime.js';

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
