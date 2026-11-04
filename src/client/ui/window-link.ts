// Tubs windows open in one browser (face, mini popup, dashboard) find each
// other over a BroadcastChannel:
// - the face window hides its mini tile while a mini window is open, so Small
//   is never on screen (and heard) twice;
// - the dashboard has no mic, camera or speakers of its own; the face window
//   shares that device state with it and takes its commands.

import type { AppState, AppStore, LogEntry, WindowPeers } from '../state/app-state.js';

export type WindowKind = keyof WindowPeers;

const CHANNEL_NAME = 'tubs-windows';
const HEARTBEAT_MS = 1500;
const PEER_TIMEOUT_MS = 4500;
// The mic level changes every frame; the dashboard meter doesn't need that.
const STATUS_INTERVAL_MS = 100;

/** Device state that lives in the face window and that the dashboard shows. */
const RELAYED_FACE_FIELDS = [
  'micReady',
  'micDenied',
  'micLevel',
  'recording',
  'listenState',
  'voiceHandsFreeEnabled',
  'voiceWakeWordEnabled',
  'voiceLastTranscript',
  'faceCameraActive',
  'faceLastDetectedCount',
  'faceWorkerReady',
  'faceWorkerBusy',
  'faceStatus',
  'faceLastInferenceMs',
  'faceDetectionDelayMs',
  'ambientAudioEnabled',
  'audioPlaying',
  // Speech and mood play out in the face window; the dashboard mirrors them.
  'currentExpression',
  'moodPos',
  'moodNeg',
  'moodArousal',
  // The face window records; the dashboard shows it and can stop it.
  'screenRecording',
  'screenRecordingSince',
  'screenRecordingFile',
] as const satisfies ReadonlyArray<keyof AppState>;
type RelayedFaceState = Pick<AppState, (typeof RELAYED_FACE_FIELDS)[number]>;

/** Face-window settings the dashboard's panels change directly in the store. */
const REMOTE_SETTINGS = ['voiceHandsFreeEnabled', 'voiceWakeWordEnabled', 'faceDetectionDelayMs'] as const satisfies ReadonlyArray<keyof AppState>;
type RemoteSettings = Pick<AppState, (typeof REMOTE_SETTINGS)[number]>;

export type FaceCommand = 'toggleCamera' | 'toggleAmbient' | 'togglePerform' | 'refreshFaces' | 'pttStart' | 'pttStop' | 'stopRecording';

type LinkMessage =
  | { type: 'here'; id: string; kind: WindowKind; reply?: boolean }
  | { type: 'gone'; id: string }
  | { type: 'face-status'; status: RelayedFaceState; perform: boolean }
  | { type: 'face-log'; entry: LogEntry }
  | { type: 'face-command'; command: FaceCommand }
  | { type: 'face-settings'; settings: RemoteSettings };

export interface WindowLink {
  /** Dashboard: ask the face window to do something only it can. */
  command(command: FaceCommand): void;
  dispose(): void;
}

/** Which kinds of window were heard from recently. A closed or crashed window times out. */
export function alivePeers(
  seen: ReadonlyMap<string, { kind: WindowKind; at: number }>,
  now: number,
  timeoutMs = PEER_TIMEOUT_MS,
): WindowPeers {
  const peers: WindowPeers = { face: false, mini: false, dashboard: false };
  for (const peer of seen.values()) {
    if (now - peer.at < timeoutMs) peers[peer.kind] = true;
  }
  return peers;
}

export function createWindowLink(
  store: AppStore,
  kind: WindowKind,
  onFaceCommand?: (command: FaceCommand) => void,
): WindowLink {
  if (typeof BroadcastChannel === 'undefined') {
    return { command() {}, dispose() {} };
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const seen = new Map<string, { kind: WindowKind; at: number }>();
  const cleanups: Array<() => void> = [];
  // Set while a face status is being applied, so it isn't echoed back as a change.
  let applyingFaceStatus = false;

  const post = (message: LinkMessage) => channel.postMessage(message);

  const syncPeers = () => {
    const next = alivePeers(seen, Date.now());
    const current = store.getState().peers;
    if (next.face !== current.face || next.mini !== current.mini || next.dashboard !== current.dashboard) {
      store.setState((state) => ({
        ...state,
        peers: next,
        ...(kind === 'dashboard' && !next.face ? { facePerform: null } : {}),
      }));
    }
  };

  const faceStatus = (): Extract<LinkMessage, { type: 'face-status' }> => {
    const state = store.getState();
    const status = Object.fromEntries(RELAYED_FACE_FIELDS.map((field) => [field, state[field]])) as RelayedFaceState;
    return { type: 'face-status', status, perform: state.uiHidden };
  };

  channel.onmessage = (event: MessageEvent<LinkMessage>) => {
    const message = event.data;
    switch (message.type) {
      case 'here': {
        const isNew = !seen.has(message.id);
        seen.set(message.id, { kind: message.kind, at: Date.now() });
        syncPeers();
        if (isNew && !message.reply) {
          // Answer right away, so a new window doesn't wait a heartbeat to know us.
          post({ type: 'here', id, kind, reply: true });
          if (kind === 'face' && message.kind === 'dashboard') post(faceStatus());
        }
        return;
      }
      case 'gone':
        seen.delete(message.id);
        syncPeers();
        return;
      case 'face-status':
        if (kind !== 'dashboard') return;
        applyingFaceStatus = true;
        store.setState((state) => ({ ...state, ...message.status, facePerform: message.perform }));
        applyingFaceStatus = false;
        return;
      case 'face-log':
        if (kind === 'dashboard') store.appendLog(message.entry.level, `[face] ${message.entry.text}`);
        return;
      case 'face-command':
        if (kind === 'face') onFaceCommand?.(message.command);
        return;
      case 'face-settings':
        if (kind === 'face') store.setState((state) => ({ ...state, ...message.settings }));
        return;
    }
  };

  post({ type: 'here', id, kind });
  const heartbeat = window.setInterval(() => {
    post({ type: 'here', id, kind, reply: true });
    syncPeers();
  }, HEARTBEAT_MS);
  cleanups.push(() => window.clearInterval(heartbeat));

  const sayGone = () => post({ type: 'gone', id });
  window.addEventListener('pagehide', sayGone);
  cleanups.push(() => window.removeEventListener('pagehide', sayGone));

  if (kind === 'face') {
    let lastSentAt = 0;
    let pending: number | null = null;
    const sendStatus = () => {
      pending = null;
      lastSentAt = Date.now();
      post(faceStatus());
    };
    cleanups.push(store.subscribeSelector(
      (state) => ({ ...faceStatus(), dashboard: state.peers.dashboard }),
      (selected) => {
        if (!selected.dashboard || pending != null) return;
        const wait = STATUS_INTERVAL_MS - (Date.now() - lastSentAt);
        if (wait <= 0) sendStatus();
        else pending = window.setTimeout(sendStatus, wait);
      },
      { equalityFn: (a, b) => a.dashboard === b.dashboard && a.perform === b.perform && shallowEqual(a.status, b.status) },
    ));
    cleanups.push(() => {
      if (pending != null) window.clearTimeout(pending);
    });

    // Errors only the face window sees (WebGPU, mic, camera) belong in the dashboard's log too.
    cleanups.push(store.subscribeSelector(
      (state) => state.logs,
      (logs, previous) => {
        const known = new Set(previous.map((entry) => entry.id));
        for (const entry of logs) {
          if (!known.has(entry.id) && entry.level === 'error') post({ type: 'face-log', entry });
        }
      },
    ));
  }

  if (kind === 'dashboard') {
    cleanups.push(store.subscribeSelector(
      (state): RemoteSettings => ({
        voiceHandsFreeEnabled: state.voiceHandsFreeEnabled,
        voiceWakeWordEnabled: state.voiceWakeWordEnabled,
        faceDetectionDelayMs: state.faceDetectionDelayMs,
      }),
      (settings) => {
        if (!applyingFaceStatus) post({ type: 'face-settings', settings });
      },
      { equalityFn: shallowEqual },
    ));
  }

  return {
    command(command) {
      post({ type: 'face-command', command });
    },
    dispose() {
      sayGone();
      for (const cleanup of cleanups) cleanup();
      channel.close();
    },
  };
}

function shallowEqual<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as Array<keyof T>;
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}
