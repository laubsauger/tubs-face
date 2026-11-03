import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse } from '../../shared/contracts/http.js';
import type { AppState, AppStore } from '../state/app-state.js';

const http = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock('../transport/http.js', () => http);

const { patchConfigLive } = await import('./runtime.js');

function fakeStore(config: Partial<ConfigResponse>): AppStore {
  let state = { config, fxBaseColorDraft: '#a855f7' } as unknown as AppState;
  return {
    getState: () => state,
    setState: (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater;
    },
    subscribe: () => () => {},
    subscribeSelector: () => () => {},
    appendLog: () => {},
  } as AppStore;
}

// Sliders fire an input event per pixel of drag. The face must follow every one
// of them, but the server should get one POST /config (and broadcast one config
// message to every client) once the value settles.
describe('patchConfigLive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    http.postJson.mockImplementation(async (_path: string, patch: Partial<ConfigResponse>) => ({ glitchPixelSize: 10, ...patch }));
  });

  afterEach(() => {
    vi.useRealTimers();
    http.postJson.mockReset();
  });

  it('updates the local config on every input but posts once with the final value', async () => {
    const store = fakeStore({ glitchPixelSize: 10 });

    for (const size of [11, 12, 13, 14]) {
      patchConfigLive(store, { glitchPixelSize: size });
      expect(store.getState().config?.glitchPixelSize).toBe(size);
    }
    expect(http.postJson).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(http.postJson).toHaveBeenCalledTimes(1);
    expect(http.postJson).toHaveBeenCalledWith('/config', { glitchPixelSize: 14 });
  });

  it('keeps separate sliders independent, so dragging one does not drop the other', async () => {
    const store = fakeStore({ glitchPixelSize: 10, glitchPixelGap: 2 });

    patchConfigLive(store, { glitchPixelSize: 20 });
    patchConfigLive(store, { glitchPixelGap: 5 });
    await vi.advanceTimersByTimeAsync(200);

    expect(http.postJson.mock.calls.map((call) => call[1])).toEqual([{ glitchPixelSize: 20 }, { glitchPixelGap: 5 }]);
  });
});
