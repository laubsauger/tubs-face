import type { WsFieldNotesServerMessage } from '../../shared/contracts/ws.js';
import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';
import type { ExpressionName } from '../../shared/contracts/config.js';
import type { ConfigResponse, HealthResponse, StatsResponse } from '../../shared/contracts/http.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { DetectedFace, EnrolledFace } from '../../shared/contracts/faces.js';
import type { TurnAction, TurnActor } from '../../shared/contracts/turn-script.js';

export interface LogEntry {
  id: string;
  level: 'info' | 'error';
  text: string;
  ts: number;
}

export interface ChatEntry {
  id: string;
  type: 'in' | 'out' | 'sys';
  actor?: 'main' | 'small' | 'user' | 'system';
  text: string;
  ts: number;
  draft?: boolean;
}

export type PanelKey =
  | 'connection'
  | 'stats'
  | 'mind'
  | 'voice'
  | 'controls'
  | 'fx'
  | 'manual'
  | 'face'
  | 'chat'
  | 'eventLog';

export interface AppState {
  connected: boolean;
  connectionLabel: string;
  lastMessageType: WsServerMessage['type'] | 'none';
  /** Server-reported duration of the last reply, for Bot Stats. */
  lastResponseMs: number | null;
  health: HealthResponse | null;
  config: ConfigResponse | null;
  stats: StatsResponse | null;
  sleeping: boolean;
  audioPlaying: boolean;
  conversationActive: boolean;
  /** When the no-wake-word window ends (ms epoch); the server only sends its length. */
  conversationUntil: number;
  /** Tubs's field notes on the people in front of him (from the server). */
  fieldNotes: Omit<WsFieldNotesServerMessage, 'type'>;
  awakeSinceTs: number;
  awakeElapsedSec: number;
  currentExpression: ExpressionName;
  currentTurnId: string | null;
  currentSpeechText: string;
  currentReactionEmoji: string;
  gazeX: number;
  gazeY: number;
  idleVariant: 'soft' | 'flat';
  blinkActive: boolean;
  lastBlinkAt: number | null;
  moodPos: number;
  moodNeg: number;
  moodArousal: number;
  micReady: boolean;
  micDenied: boolean;
  micLevel: number;
  recording: boolean;
  listenState: string;
  voiceWakeWordEnabled: boolean;
  voiceHandsFreeEnabled: boolean;
  voiceLastTranscript: string;
  ambientAudioEnabled: boolean;
  faceWorkerReady: boolean;
  faceWorkerBusy: boolean;
  faceCameraActive: boolean;
  faceStatus: string;
  faceLastInferenceMs: number | null;
  faceLastDetectedCount: number;
  faceLastEmbeddingsExtracted: number;
  faceLastEmbeddingsReused: number;
  faceFrameWidth: number | null;
  faceFrameHeight: number | null;
  faceLastFaces: DetectedFace[];
  faceLibraryFaces: EnrolledFace[];
  faceLibraryEmbeddings: number;
  faceLibraryPeople: number;
  faceDraftName: string;
  /** Pause between face detections in ms; 0 follows the measured inference time. */
  faceDetectionDelayMs: number;
  /** Face onboarding wizard is open (F key or the Onboard button). */
  faceEnrollOpen: boolean;
  controlSpeakText: string;
  chatComposerText: string;
  uiHidden: boolean;
  debugOverlayActive?: boolean;
  fullscreenActive: boolean;
  collapsedPanels: Partial<Record<PanelKey, boolean>>;
  chatPanelWidth: number | null;
  chatVerbosity: 'all' | 'chat' | 'minimal';
  manualComposerMode: 'single' | 'script';
  manualActor: TurnActor;
  manualAction: TurnAction;
  manualExpression: string;
  manualEmoji: string;
  manualDelay: string;
  manualText: string;
  manualScript: string;
  manualStatus: string;
  manualStatusKind: 'idle' | 'ok' | 'error' | 'busy';
  manualSending: boolean;
  fxEditorOpen: boolean;
  fxExpressionSelected: ExpressionName;
  fxBaseColorDraft: `#${string}`;
  chatEntries: ChatEntry[];
  liveTranscriptText: string;
  liveTranscriptDraft: boolean;
  logs: LogEntry[];
}

export type StateListener = (state: AppState) => void;
export interface SelectorSubscribeOptions<T> {
  equalityFn?: (left: T, right: T) => boolean;
  fireImmediately?: boolean;
}

export interface AppStore {
  getState(): AppState;
  setState(updater: AppState | ((current: AppState) => AppState)): void;
  subscribe(listener: StateListener): () => void;
  subscribeSelector<T>(
    selector: (state: AppState) => T,
    listener: (selected: T, previousSelected: T) => void,
    options?: SelectorSubscribeOptions<T>,
  ): () => void;
  appendLog(level: LogEntry['level'], text: string): void;
}

// Enough to see what led up to an error.
const MAX_LOGS = 100;
const UI_PREFS_STORAGE_KEY = 'tubs.uiPrefs';

/** Layout choices an operator expects to survive a reload of the studio screen. */
type UiPrefs = Pick<AppState, 'uiHidden' | 'collapsedPanels' | 'chatPanelWidth'>;

function readStoredUiPrefs(): Partial<UiPrefs> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UI_PREFS_STORAGE_KEY) ?? '{}') as Partial<UiPrefs>;
    return {
      ...(typeof parsed.uiHidden === 'boolean' ? { uiHidden: parsed.uiHidden } : {}),
      ...(parsed.collapsedPanels && typeof parsed.collapsedPanels === 'object' ? { collapsedPanels: parsed.collapsedPanels } : {}),
      ...(typeof parsed.chatPanelWidth === 'number' ? { chatPanelWidth: parsed.chatPanelWidth } : {}),
    };
  } catch {
    return {};
  }
}

/** Saves uiHidden, collapsed panels and chat width whenever they change. */
export function persistUiPrefs(store: AppStore): () => void {
  return store.subscribeSelector(
    (state): UiPrefs => ({ uiHidden: state.uiHidden, collapsedPanels: state.collapsedPanels, chatPanelWidth: state.chatPanelWidth }),
    (prefs) => {
      try {
        window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
      } catch {
        // Private mode or blocked storage: layout just won't persist.
      }
    },
    { equalityFn: (a, b) => a.uiHidden === b.uiHidden && a.collapsedPanels === b.collapsedPanels && a.chatPanelWidth === b.chatPanelWidth },
  );
}

export function createAppStore(): AppStore {
  const initialState: AppState = {
    connected: false,
    connectionLabel: 'Offline',
    lastMessageType: 'none',
    lastResponseMs: null,
    health: null,
    config: null,
    stats: null,
    sleeping: false,
    audioPlaying: false,
    conversationActive: false,
    conversationUntil: 0,
    fieldNotes: { people: [], groupNotes: [], quotes: [] },
    awakeSinceTs: Date.now(),
    awakeElapsedSec: 0,
    currentExpression: 'idle',
    currentTurnId: null,
    currentSpeechText: '',
    currentReactionEmoji: '',
    gazeX: 0,
    gazeY: 0,
    idleVariant: 'soft',
    blinkActive: false,
    lastBlinkAt: null,
    moodPos: 0.24,
    moodNeg: 0.06,
    moodArousal: 0.2,
    micReady: false,
    micDenied: false,
    micLevel: 0,
    recording: false,
    listenState: 'Idle',
    voiceWakeWordEnabled: false,
    voiceHandsFreeEnabled: true,
    voiceLastTranscript: '',
    ambientAudioEnabled: true,
    faceWorkerReady: false,
    faceWorkerBusy: false,
    faceCameraActive: false,
    faceStatus: 'Idle',
    faceLastInferenceMs: null,
    faceLastDetectedCount: 0,
    faceLastEmbeddingsExtracted: 0,
    faceLastEmbeddingsReused: 0,
    faceFrameWidth: null,
    faceFrameHeight: null,
    faceLastFaces: [],
    faceLibraryFaces: [],
    faceLibraryEmbeddings: 0,
    faceLibraryPeople: 0,
    faceDraftName: '',
    faceEnrollOpen: false,
    faceDetectionDelayMs: 0,
    controlSpeakText: '',
    chatComposerText: '',
    uiHidden: false,
    fullscreenActive: false,
    collapsedPanels: {
      connection: true,
      voice: true,
      stats: true,
      controls: true,
      manual: true,
      mind: true,
      eventLog: true,
    },
    chatPanelWidth: null,
    chatVerbosity: 'all',
    manualComposerMode: 'single',
    manualActor: 'main',
    manualAction: 'speak',
    manualExpression: '',
    manualEmoji: '',
    manualDelay: '',
    manualText: '',
    manualScript: '',
    manualStatus: 'Ready',
    manualStatusKind: 'idle',
    manualSending: false,
    fxEditorOpen: false,
    fxExpressionSelected: 'idle',
    fxBaseColorDraft: '#a855f7',
    chatEntries: [],
    liveTranscriptText: '',
    liveTranscriptDraft: false,
    logs: [],
  };
  const storedPrefs = readStoredUiPrefs();
  // Merge panel state so panels added later start with their default.
  Object.assign(initialState, storedPrefs, {
    collapsedPanels: { ...initialState.collapsedPanels, ...storedPrefs.collapsedPanels },
  });
  const store = createStore<AppState>()(subscribeWithSelector(() => initialState));

  return {
    getState(): AppState {
      return store.getState();
    },
    setState(updater): void {
      const next = typeof updater === 'function' ? updater(store.getState()) : updater;
      store.setState(next, true);
    },
    subscribe(listener): () => void {
      return store.subscribe(listener);
    },
    subscribeSelector(selector, listener, options): () => void {
      return store.subscribe(selector, listener, options);
    },
    appendLog(level, text): void {
      const entry: LogEntry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        level,
        text,
        ts: Date.now(),
      };
      store.setState((current) => ({
        ...current,
        logs: [entry, ...current.logs].slice(0, MAX_LOGS),
      }));
    },
  };
}

