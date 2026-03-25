import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';
import type { ExpressionName } from '../../shared/contracts/config.js';
import type { ConfigResponse, HealthResponse, StatsResponse } from '../../shared/contracts/http.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { DetectedFace } from '../../shared/contracts/faces.js';
import type { DonationSignalPayload } from '../../shared/contracts/ws.js';
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

export interface StreamDebugEntry {
  id: string;
  stage: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface StreamDebugState {
  enabled: boolean;
  currentTurnId: string | null;
  llmDeltas: number;
  llmChars: number;
  sentences: number;
  ttsSentences: number;
  ttsChars: number;
  audioChunksIn: number;
  audioBytesIn: number;
  audioChunksPlayed: number;
  audioSecondsPlayed: number;
  entries: StreamDebugEntry[];
}

export type PanelKey =
  | 'connection'
  | 'health'
  | 'config'
  | 'stats'
  | 'assistant'
  | 'voice'
  | 'controls'
  | 'fx'
  | 'manual'
  | 'face'
  | 'chat'
  | 'streamDebug'
  | 'eventLog';

export interface AppState {
  connected: boolean;
  connectionLabel: string;
  serverUrl: string;
  lastMessageType: WsServerMessage['type'] | 'none';
  lastPingMs: number | null;
  health: HealthResponse | null;
  config: ConfigResponse | null;
  stats: StatsResponse | null;
  sleeping: boolean;
  audioPlaying: boolean;
  conversationActive: boolean;
  awakeSinceTs: number;
  awakeElapsedSec: number;
  currentExpression: ExpressionName;
  currentTurnId: string | null;
  currentIncomingText: string;
  currentSpeechText: string;
  currentReactionEmoji: string;
  currentDonationSignal: DonationSignalPayload | null;
  subtitleText: string;
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
  faceLibraryEmbeddings: number;
  faceLibraryPeople: number;
  faceDraftName: string;
  controlSpeakText: string;
  controlDonationAmount: string;
  uiHidden: boolean;
  fullscreenActive: boolean;
  collapsedPanels: Partial<Record<PanelKey, boolean>>;
  chatPanelWidth: number | null;
  chatVerbosity: 'all' | 'chat' | 'minimal';
  manualComposerOpen: boolean;
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
  streamDebug: StreamDebugState;
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

const MAX_LOGS = 10;
const STREAM_DEBUG_STORAGE_KEY = 'tubs.streamDebugEnabled';

export function createAppStore(serverUrl: string): AppStore {
  const streamDebugEnabled = readStoredStreamDebugEnabled();
  const initialState: AppState = {
    connected: false,
    connectionLabel: 'Offline',
    serverUrl,
    lastMessageType: 'none',
    lastPingMs: null,
    health: null,
    config: null,
    stats: null,
    sleeping: false,
    audioPlaying: false,
    conversationActive: false,
    awakeSinceTs: Date.now(),
    awakeElapsedSec: 0,
    currentExpression: 'idle',
    currentTurnId: null,
    currentIncomingText: '',
    currentSpeechText: '',
    currentReactionEmoji: '',
    currentDonationSignal: null,
    subtitleText: '',
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
    faceLibraryEmbeddings: 0,
    faceLibraryPeople: 0,
    faceDraftName: '',
    controlSpeakText: 'Hello from the TypeScript shell.',
    controlDonationAmount: '5.00',
    uiHidden: false,
    fullscreenActive: false,
    collapsedPanels: {},
    chatPanelWidth: null,
    chatVerbosity: 'all',
    manualComposerOpen: false,
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
    streamDebug: {
      enabled: streamDebugEnabled,
      currentTurnId: null,
      llmDeltas: 0,
      llmChars: 0,
      sentences: 0,
      ttsSentences: 0,
      ttsChars: 0,
      audioChunksIn: 0,
      audioBytesIn: 0,
      audioChunksPlayed: 0,
      audioSecondsPlayed: 0,
      entries: [],
    },
    logs: [],
  };
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

function readStoredStreamDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem(STREAM_DEBUG_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
