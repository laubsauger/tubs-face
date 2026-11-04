import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsClientMessage } from '../../shared/contracts/ws.js';
import type { AppState, AppStore } from '../state/app-state.js';
import { PROACTIVE_DELAY_MS, PROACTIVE_MAX_DELAY_MS, createProactiveRuntime } from './proactive-runtime.js';

// When Tubs speaks up on his own. Too eager and an ignored visitor (or an
// empty room) hears a line every minute; too shy and he never starts talking.

function fakeStore(initial: Partial<AppState>): AppStore & { set(patch: Partial<AppState>): void } {
  let state = { sleeping: false, audioPlaying: false, faceLastDetectedCount: 1, faceLastFaces: [], faceEnrollOpen: false, ...initial } as unknown as AppState;
  const watchers: Array<{ select: (s: AppState) => unknown; last: unknown; listener: (value: unknown) => void }> = [];
  const store = {
    getState: () => state,
    setState: (updater: (s: AppState) => AppState) => {
      state = updater(state);
      for (const watcher of watchers) {
        const value = watcher.select(state);
        if (value !== watcher.last) {
          watcher.last = value;
          watcher.listener(value);
        }
      }
    },
    subscribe: () => () => {},
    subscribeSelector: (select: (s: AppState) => unknown, listener: (value: unknown) => void) => {
      const watcher = { select, last: select(state), listener };
      watchers.push(watcher);
      return () => watchers.splice(watchers.indexOf(watcher), 1);
    },
    appendLog: () => {},
    set(patch: Partial<AppState>) {
      store.setState((s) => ({ ...s, ...patch }));
    },
  };
  return store as unknown as AppStore & { set(patch: Partial<AppState>): void };
}

describe('proactive lines', () => {
  let sent: WsClientMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter
    sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function start(store: AppStore) {
    const runtime = createProactiveRuntime(store);
    runtime.init((message) => sent.push(message));
    return runtime;
  }

  it('speaks up after 45 s of silence with someone in front of it', () => {
    start(fakeStore({}));
    vi.advanceTimersByTime(PROACTIVE_DELAY_MS + 10);
    expect(sent.map((message) => message.type)).toEqual(['proactive']);
  });

  it('waits twice as long after each line nobody answered, up to ten minutes', () => {
    const runtime = start(fakeStore({}));
    const gaps: number[] = [];
    let last = 0;
    for (let elapsed = 0; elapsed <= 40 * 60_000 && gaps.length < 6; elapsed += 1000) {
      vi.advanceTimersByTime(1000);
      if (sent.length > gaps.length) {
        gaps.push(elapsed + 1000 - last);
        last = elapsed + 1000;
        runtime.onActivity(); // Tubs's own line arriving does not count as an answer.
      }
    }
    expect(gaps.slice(0, 5)).toEqual([45_000, 90_000, 180_000, 360_000, PROACTIVE_MAX_DELAY_MS]);
  });

  it('goes back to the short wait once the visitor answers', () => {
    const runtime = start(fakeStore({}));
    vi.advanceTimersByTime(PROACTIVE_DELAY_MS);
    vi.advanceTimersByTime(2 * PROACTIVE_DELAY_MS);
    expect(sent).toHaveLength(2);
    runtime.onUserTurn();
    // Back to 45 s waits (the first one lands inside the 60 s cooldown and
    // waits once more); without the reset it would be 180 s.
    vi.advanceTimersByTime(2 * PROACTIVE_DELAY_MS + 10);
    expect(sent).toHaveLength(3);
  });

  it('a new visitor gets a fresh start, a flickering face does not', () => {
    const store = fakeStore({});
    start(store);
    vi.advanceTimersByTime(PROACTIVE_DELAY_MS); // 1 unanswered
    vi.advanceTimersByTime(2 * PROACTIVE_DELAY_MS); // 2 unanswered
    store.set({ faceLastDetectedCount: 0 });
    vi.advanceTimersByTime(500);
    store.set({ faceLastDetectedCount: 1 }); // flicker: still the same person
    vi.advanceTimersByTime(2 * PROACTIVE_DELAY_MS);
    expect(sent).toHaveLength(2);

    store.set({ faceLastDetectedCount: 0 });
    vi.advanceTimersByTime(15_000);
    store.set({ faceLastDetectedCount: 1 }); // someone new
    vi.advanceTimersByTime(PROACTIVE_DELAY_MS + 10);
    expect(sent).toHaveLength(3);
  });

  it('stays quiet with nobody in front of the camera', () => {
    start(fakeStore({ faceLastDetectedCount: 0 }));
    vi.advanceTimersByTime(PROACTIVE_MAX_DELAY_MS * 2);
    expect(sent).toEqual([]);
  });
});
