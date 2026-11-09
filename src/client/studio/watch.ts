// The dashboard's side of the studio listener's live state. In studio mode the
// dashboard has no mic or camera; the listener page has them, possibly on
// another machine; the operator face window has let go of its own. Such a
// page says what it shows (studio_watch: the live state while it is on
// screen, the camera while the People or Studio tab or the onboarding dialog
// is open), keeps what comes back apart from its own device state (the panels
// show it in its place, live-view.ts), and runs onboarding on the listener's
// camera (studio_face_call).

import type { StudioFaceMethod } from '../../shared/contracts/studio.js';
import type { EnrollmentCapture } from '../face/enrollment.js';
import type { EmbedResult } from '../face/runtime.js';
import type { AppShellControls } from '../ui/app-shell.js';
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
        case 'studio_live': {
          // Kept apart from this page's own mic and camera state; the panels show it in their place (live-view.ts).
          const status = message.status;
          store.setState((current) => (status
            ? { ...current, studioLive: { status, speaking: message.speaking, faceWorker: message.faceWorker ?? null, at: Date.now() } }
            : { ...current, studioLive: null, studioFrame: null, studioObservation: null }));
          return true;
        }
        case 'face_observation':
          store.setState((current) => ({ ...current, studioObservation: message.observation }));
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

type FaceControls = NonNullable<AppShellControls['face']>;

/** A photo as a JPEG data URL, at most PICTURE_MAX_PX on its longest side. */
const PICTURE_MAX_PX = 1280;
async function pictureDataUrl(image: Blob): Promise<string> {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, PICTURE_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** The listener's answer to embedPicture: a sample, or the reason the photo can't be used. */
export function embedResultOf(value: unknown): EmbedResult {
  if (typeof value === 'object' && value !== null) {
    const result = value as { ok?: unknown; sample?: unknown; reason?: unknown };
    if (result.ok === true) {
      const sample = enrollmentCaptureOf(result.sample);
      if (sample) return { ok: true, sample };
    } else if (typeof result.reason === 'string') {
      return { ok: false, reason: result.reason.slice(0, 200) };
    }
  }
  return { ok: false, reason: 'the studio listener sent no usable answer' };
}

/** The studio listener's answer to a pose capture: one pose, or null when no single face was found. */
export function enrollmentCaptureOf(value: unknown): EnrollmentCapture | null {
  if (typeof value !== 'object' || value === null) return null;
  const { embedding, thumbnail, duplicate } = value as Partial<EnrollmentCapture>;
  return Array.isArray(embedding) && embedding.every((n) => typeof n === 'number') && typeof thumbnail === 'string' && thumbnail.startsWith('data:image/')
    ? { embedding, thumbnail, duplicate: duplicate === true }
    : null;
}

/**
 * The same face controls, with onboarding run on the studio listener's
 * camera while it reports (studio mode); this page's own otherwise.
 */
export function withStudioCamera(face: FaceControls, store: AppStore, watch: () => StudioWatch | null): FaceControls {
  const studio = () => (store.getState().studioLive ? watch() : null);
  return {
    ...face,
    toggleCamera: async () => {
      if (studio()) store.appendLog('info', 'The studio camera is the vision source: choose it in the Studio tab');
      else await face.toggleCamera();
    },
    getCameraStream: () => (studio() ? null : face.getCameraStream()),
    beginEnrollment: () => {
      const camera = studio();
      if (camera) void camera.call('beginEnrollment').catch(() => {});
      else face.beginEnrollment();
    },
    endEnrollment: () => {
      const camera = studio();
      if (camera) void camera.call('endEnrollment').catch(() => {});
      else face.endEnrollment();
    },
    captureEnrollmentSample: async (previous, choose) => {
      const camera = studio();
      if (!camera) return face.captureEnrollmentSample(previous, choose);
      return enrollmentCaptureOf(await camera.call('captureEnrollmentSample', { previous, ...(choose ? { choose } : {}) }));
    },
    embedPicture: async (image) => {
      const camera = studio();
      if (!camera) return face.embedPicture(image);
      // Smaller first: a phone photo is megabytes, the worker looks at 960 px anyway.
      const picture = await pictureDataUrl(image).catch(() => null);
      if (!picture) return { ok: false, reason: 'not an image this browser can read' };
      return embedResultOf(await camera.call('embedPicture', { image: picture }).catch((error: unknown) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) })));
    },
    saveEnrollment: async (name, samples) => {
      const camera = studio();
      if (!camera) return face.saveEnrollment(name, samples);
      const saved = Number(await camera.call('saveEnrollment', { name, samples: samples.map(({ embedding, thumbnail }) => ({ embedding, thumbnail })) }));
      await face.refreshLibrary();
      return Number.isFinite(saved) ? saved : 0;
    },
  };
}
