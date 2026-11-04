import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

const FULLSCREEN_STORAGE_KEY = 'tubs.dualFullscreenDesired';
const MINI_FULLSCREEN_MESSAGE_TYPE = 'tubs-mini-fullscreen';

export interface WindowRuntime {
  init(): void;
  dispose(): void;
}

let sharedMiniWindowRef: Window | null = null;

// Keys live in the operator shell's hotkey router (ui/hud/hotkeys.ts); this
// runtime keeps fullscreen in step between the face and mini windows.
export function createWindowRuntime(store: AppStore, mode: 'main' | 'mini'): WindowRuntime {
  let clickHandler: (() => void) | null = null;

  return {
    init(): void {
      if (mode === 'main') {
        initMainControls();
      } else {
        initMiniSync();
      }
    },
    dispose(): void {
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
      syncMiniFullscreenIntent(isFullscreenActive());
    };

    document.addEventListener('fullscreenchange', syncState);
    document.addEventListener('webkitfullscreenchange', syncState as EventListener);
    syncState();

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

  function syncMiniFullscreenIntent(enabled: boolean): void {
    if (mode !== 'main') {
      return;
    }
    syncMiniFullscreenIntentShared(enabled);
  }
}

export async function toggleFullscreen(store: AppStore): Promise<void> {
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
    // Only a mini window that is already open follows. Opening one here would
    // pull Small out of the face window's tile, which a one-screen show needs.
    syncMiniFullscreenIntentShared(next);
  } catch (error) {
    store.appendLog('error', error instanceof Error ? error.message : 'Fullscreen unavailable');
  }
}

/**
 * Opens (or focuses) mini Tubs in its own window, for a second screen, and
 * turns two-head mode on. Closing it again hands Small back to the face
 * window's tile; two-head mode stays until the operator turns it off.
 */
export function openMiniWindow(store: AppStore, focus: boolean): Window | null {
  if (sharedMiniWindowRef && !sharedMiniWindowRef.closed) {
    void enableDualHead(store);
    if (focus) {
      sharedMiniWindowRef.focus();
    }
    return sharedMiniWindowRef;
  }

  const opened = window.open('/app-mini.html', 'tubs-mini-face', 'popup=yes,width=560,height=420,left=80,top=80,resizable=yes');
  if (!opened) {
    store.appendLog('error', 'Popup blocked: allow popups to open Mini Window');
    return null;
  }
  sharedMiniWindowRef = opened;
  void enableDualHead(store);
  if (focus) {
    opened.focus();
  }
  if (store.getState().fullscreenActive) {
    window.setTimeout(() => {
      syncMiniFullscreenIntentShared(true);
    }, 300);
  }
  return opened;
}

function syncMiniFullscreenIntentShared(enabled: boolean): void {
  writeFullscreenIntent(enabled);
  const targetWindow = sharedMiniWindowRef;
  if (!targetWindow || targetWindow.closed) {
    return;
  }
  targetWindow.postMessage({
    type: MINI_FULLSCREEN_MESSAGE_TYPE,
    enabled,
    ts: Date.now(),
  }, location.origin);
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

async function enableDualHead(store: AppStore): Promise<void> {
  if (store.getState().config?.dualHeadEnabled && store.getState().config?.dualHeadMode !== 'off') {
    return;
  }
  try {
    await postJson('/config', { dualHeadEnabled: true, dualHeadMode: 'llm_directed' });
  } catch (error) {
    store.appendLog('error', error instanceof Error ? error.message : 'Failed to enable dual-head mode');
  }
}

/** Opens the operator dashboard in its own window, for a third screen. */
export function openDashboardWindow(store: AppStore): void {
  const opened = window.open('/?view=dashboard', 'tubs-dashboard', 'popup=yes,width=1280,height=860,resizable=yes');
  if (!opened) {
    store.appendLog('error', 'Popup blocked: allow popups to open the dashboard');
    return;
  }
  opened.focus();
}

/** Dashboard: brings the face window up (or opens it), e.g. after it was closed. */
export function openFaceWindow(store: AppStore): void {
  const opened = window.open('/', 'tubs-face');
  if (!opened) {
    store.appendLog('error', 'Popup blocked: allow popups to open the face window');
    return;
  }
  opened.focus();
}
