// The dashboard's side of the studio listener's live state. In studio mode the
// dashboard has no mic or camera; the listener page has them, possibly on
// another machine. The dashboard says what it shows (studio_watch: the live
// state while it is on screen, the camera while the People or Studio tab or
// the onboarding dialog is open), puts what comes back into the same app state
// fields the face window would fill, so its own meters, detection lists and
// face boxes show it, and runs onboarding on the listener's camera
// (studio_face_call).

import type { StudioFaceMethod } from '../../shared/contracts/studio.js';
import type { WsClientMessage, WsServerMessage } from '../../shared/contracts/ws.js';
import type { AppState, AppStore } from '../state/app-state.js';

/** A face call with no answer by then fails (the listener page went away mid-call). */
export const FACE_CALL_TIMEOUT_MS = 30_000;

export interface StudioWatch {
  /** studio_live, studio_frame, studio_pulse, studio_face_result: true when it took the message. */
  handle(message: WsServerMessage): boolean;
  /** Runs a face runtime method on the studio listener page. */
  call(method: StudioFaceMethod, args?: Record<string, unknown>): Promise<unknown>;
  dispose(): void;
}

type WatchSlice = Pick<AppState, 'connected' | 'dockTab' | 'dockFolded' | 'uiHidden' | 'faceEnrollOpen'> & { visible: boolean };

/** What this dashboard shows: the live state while it is on screen, the camera only where it is drawn. */
export function watchFor(state: WatchSlice): { live: boolean; video: boolean } {
  if (!state.connected || !state.visible) return { live: false, video: false };
  const tabShown = !state.dockFolded && !state.uiHidden && (state.dockTab === 'people' || state.dockTab === 'studio');
  return { live: true, video: state.faceEnrollOpen || tabShown };
}

/** The listener stopped (or never reported): nothing of it stays on screen. */
const STOPPED: Partial<AppState> = {
  studioLive: null,
  studioFrame: null,
  micReady: false,
  micLevel: 0,
  recording: false,
  faceCameraActive: false,
  faceLastFaces: [],
  faceLastDetectedCount: 0,
};

export function createStudioWatch(store: AppStore, send: (message: WsClientMessage) => void): StudioWatch {
  let visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  let sent = { live: false, video: false };
  let callSeq = 0;
  const calls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }>();

  const sync = (force = false) => {
    const next = watchFor({ ...store.getState(), visible });
    if (!force && next.live === sent.live && next.video === sent.video) return;
    sent = next;
    if (store.getState().studioVideoWanted !== next.video) store.setState((current) => ({ ...current, studioVideoWanted: next.video }));
    if (store.getState().connected) send({ type: 'studio_watch', ...next });
  };

  const unsubscribe = store.subscribeSelector(
    (state) => `${state.connected}|${state.dockTab}|${state.dockFolded}|${state.uiHidden}|${state.faceEnrollOpen}`,
    (_key, previous) => {
      // A new socket knows nothing of this dashboard: say it again.
      const reconnected = store.getState().connected && previous.startsWith('false|');
      sync(reconnected);
    },
  );
  const onVisibility = () => {
    visible = document.visibilityState === 'visible';
    sync();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  sync(true);

  return {
    handle(message) {
      switch (message.type) {
        case 'studio_live':
          if (!message.status) {
            store.setState((current) => ({ ...current, ...STOPPED }));
          } else {
            const status = message.status;
            store.setState((current) => ({ ...current, ...status, studioLive: { speaking: message.speaking, at: Date.now() } }));
          }
          return true;
        case 'studio_frame':
          store.setState((current) => ({ ...current, studioFrame: { src: message.frame, width: message.width, height: message.height } }));
          return true;
        case 'studio_pulse':
          store.setState((current) => ({ ...current, studioPulse: message.pulse }));
          return true;
        case 'studio_face_result': {
          const call = calls.get(message.id);
          if (!call) return true;
          calls.delete(message.id);
          window.clearTimeout(call.timer);
          if (message.ok) call.resolve(message.value ?? null);
          else call.reject(new Error(message.error || 'the studio listener could not do that'));
          return true;
        }
        default:
          return false;
      }
    },
    call(method, args) {
      callSeq += 1;
      const id = `f${callSeq}-${Date.now().toString(36)}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          calls.delete(id);
          reject(new Error('the studio listener did not answer'));
        }, FACE_CALL_TIMEOUT_MS);
        calls.set(id, { resolve, reject, timer });
        send({ type: 'studio_face_call', id, method, ...(args ? { args } : {}) });
      });
    },
    dispose() {
      unsubscribe();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      for (const call of calls.values()) {
        window.clearTimeout(call.timer);
        call.reject(new Error('closed'));
      }
      calls.clear();
    },
  };
}
