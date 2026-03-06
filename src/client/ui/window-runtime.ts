import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

const FULLSCREEN_STORAGE_KEY = 'tubs.dualFullscreenDesired';
const MINI_FULLSCREEN_MESSAGE_TYPE = 'tubs-mini-fullscreen';

export interface WindowRuntime {
  bind(root: HTMLElement): void;
  init(): void;
  dispose(): void;
}

export function createWindowRuntime(store: AppStore, mode: 'main' | 'mini'): WindowRuntime {
  let rootEl: HTMLElement | null = null;
  let miniWindowRef: Window | null = null;
  let keyHandler: ((event: KeyboardEvent) => void) | null = null;
  let clickHandler: (() => void) | null = null;

  return {
    bind(root: HTMLElement): void {
      rootEl = root;

      if (mode === 'main') {
        const fullscreenButton = root.querySelector<HTMLButtonElement>('#window-fullscreen');
        const miniButton = root.querySelector<HTMLButtonElement>('#window-open-mini');
        if (fullscreenButton) {
          fullscreenButton.onclick = async () => {
            await toggleFullscreen();
          };
        }
        if (miniButton) {
          miniButton.onclick = () => {
            openMiniWindow(true);
          };
        }
      }
    },
    init(): void {
      if (mode === 'main') {
        initMainControls();
      } else {
        initMiniSync();
      }
    },
    dispose(): void {
      if (keyHandler) {
        window.removeEventListener('keydown', keyHandler);
      }
      if (clickHandler) {
        window.removeEventListener('click', clickHandler);
      }
    },
  };

  function initMainControls(): void {
    const syncState = () => {
      store.setState((current) => ({
        ...current,
        fullscreenActive: isFullscreenActive(),
      }));
      syncMiniFullscreenIntent(isFullscreenActive(), false);
    };

    document.addEventListener('fullscreenchange', syncState);
    document.addEventListener('webkitfullscreenchange', syncState as EventListener);
    syncState();

    keyHandler = (event: KeyboardEvent) => {
      const target = event.target;
      const inInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement;

      if (event.code === 'Escape') {
        event.preventDefault();
        if (store.getState().sleeping) {
          void postJson<undefined, { ok: true }>('/wake');
        } else {
          void postJson<undefined, { ok: true }>('/sleep');
        }
        return;
      }

      if (inInput) {
        return;
      }

      if (event.key === 'x' || event.key === 'X') {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }

      if (event.key === 'z' || event.key === 'Z') {
        event.preventDefault();
        store.setState((current) => ({
          ...current,
          uiHidden: !current.uiHidden,
        }));
        return;
      }

      if (event.key === 'o' || event.key === 'O') {
        event.preventDefault();
        openMiniWindow(true);
      }
    };

    window.addEventListener('keydown', keyHandler);

    clickHandler = () => {
      if (store.getState().sleeping) {
        void postJson<undefined, { ok: true }>('/wake');
      }
    };
    window.addEventListener('click', clickHandler);
  }

  function initMiniSync(): void {
    const desired = readFullscreenIntent();
    if (desired) {
      void applyMiniFullscreen(true);
    }

    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin) {
        return;
      }
      const payload = event.data;
      if (!payload || payload.type !== MINI_FULLSCREEN_MESSAGE_TYPE) {
        return;
      }
      const enabled = Boolean(payload.enabled);
      writeFullscreenIntent(enabled);
      void applyMiniFullscreen(enabled);
    });

    window.addEventListener('storage', (event) => {
      if (event.key !== FULLSCREEN_STORAGE_KEY) {
        return;
      }
      void applyMiniFullscreen(readFullscreenIntent());
    });
  }

  async function toggleFullscreen(): Promise<void> {
    const next = !isFullscreenActive();
    try {
      if (next) {
        await requestFullscreen();
      } else {
        await exitFullscreen();
      }
      writeFullscreenIntent(next);
      store.setState((current) => ({
        ...current,
        fullscreenActive: next,
      }));
      syncMiniFullscreenIntent(next, next);
    } catch (error) {
      store.appendLog('error', error instanceof Error ? error.message : 'Fullscreen unavailable');
    }
  }

  function openMiniWindow(focus: boolean): Window | null {
    if (mode !== 'main') {
      return null;
    }
    if (miniWindowRef && !miniWindowRef.closed) {
      if (focus) {
        miniWindowRef.focus();
      }
      return miniWindowRef;
    }

    const opened = window.open('/app-mini.html', 'tubs-mini-face', 'popup=yes,width=560,height=420,left=80,top=80,resizable=yes');
    if (!opened) {
      store.appendLog('error', 'Popup blocked: allow popups to open Mini Window');
      return null;
    }
    miniWindowRef = opened;
    if (focus) {
      opened.focus();
    }
    if (store.getState().fullscreenActive) {
      window.setTimeout(() => {
        syncMiniFullscreenIntent(true, false);
      }, 300);
    }
    return opened;
  }

  function syncMiniFullscreenIntent(enabled: boolean, openIfNeeded: boolean): void {
    if (mode !== 'main') {
      return;
    }
    writeFullscreenIntent(enabled);
    let targetWindow = miniWindowRef;
    if ((!targetWindow || targetWindow.closed) && enabled && openIfNeeded) {
      targetWindow = openMiniWindow(false);
    }
    if (!targetWindow || targetWindow.closed) {
      return;
    }
    targetWindow.postMessage({
      type: MINI_FULLSCREEN_MESSAGE_TYPE,
      enabled,
      ts: Date.now(),
    }, location.origin);
  }
}

function isFullscreenActive(): boolean {
  return Boolean(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);
}

async function requestFullscreen(): Promise<void> {
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (root.requestFullscreen) {
    await root.requestFullscreen();
    return;
  }
  if (root.webkitRequestFullscreen) {
    root.webkitRequestFullscreen();
    return;
  }
  throw new Error('Fullscreen API unavailable');
}

async function exitFullscreen(): Promise<void> {
  const doc = document as Document & { webkitExitFullscreen?: () => void };
  if (document.exitFullscreen) {
    await document.exitFullscreen();
    return;
  }
  if (doc.webkitExitFullscreen) {
    doc.webkitExitFullscreen();
    return;
  }
  throw new Error('Fullscreen API unavailable');
}

function writeFullscreenIntent(enabled: boolean): void {
  try {
    localStorage.setItem(FULLSCREEN_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage failures
  }
}

function readFullscreenIntent(): boolean {
  try {
    return localStorage.getItem(FULLSCREEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

async function applyMiniFullscreen(enabled: boolean): Promise<void> {
  if (enabled === isFullscreenActive()) {
    return;
  }
  if (enabled) {
    await requestFullscreen().catch(() => {});
  } else {
    await exitFullscreen().catch(() => {});
  }
}
