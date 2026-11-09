import type { WsFieldNotesServerMessage } from '../../shared/contracts/ws.js';
import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';
import type { ExpressionName } from '../../shared/contracts/config.js';
import type { ConfigResponse, HealthResponse, StatsResponse } from '../../shared/contracts/http.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { DetectedFace, EnrolledFace } from '../../shared/contracts/faces.js';
import type { TurnAction, TurnActor } from '../../shared/contracts/turn-script.js';
import type { FaceObservation, StudioFaceWorkerStatus, StudioLiveStatus, StudioPulse } from '../../shared/contracts/studio.js';

export type ScreenRecordingPhase = 'idle' | 'starting' | 'recording' | 'saving';

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
  /** A pre-rendered filler line, not model output; shown muted in the chat log. */
  filler?: boolean;
}

/** Operator dock tabs, in rail order. */
export const DOCK_TABS = ['chat', 'studio', 'voice', 'mind', 'people', 'memory', 'controls', 'stats', 'log', 'settings', 'fx'] as const;
export type DockTab = (typeof DOCK_TABS)[number];

export const MINI_TILE_PLACEMENTS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'side'] as const;
export type MiniTilePlacement = (typeof MINI_TILE_PLACEMENTS)[number];
export const MINI_TILE_SIZES = ['small', 'medium', 'large'] as const;
export type MiniTileSize = (typeof MINI_TILE_SIZES)[number];

/**
 * What the face screen shows besides the face. Shared by every operator window
 * in this browser, so the dashboard can set up the perform screen.
 */
export interface StagePrefs {
  subtitles: boolean;
  transcript: boolean;
  /** The listening dot, plus the live transcript of what the mic hears. */
  listening: boolean;
  miniTile: boolean;
  miniPlacement: MiniTilePlacement;
  miniSize: MiniTileSize;
}

/** Other Tubs windows open in this browser (see ui/window-link.ts). */
export interface WindowPeers {
  face: boolean;
  mini: boolean;
  dashboard: boolean;
}

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
  /** Since when a voice has been rendering on the server (null: none). Face checks wait meanwhile. */
  ttsRenderingSince: number | null;
  /** Face onboarding wizard is open (F key or the Onboard button). */
  faceEnrollOpen: boolean;
  /**
   * Dashboard in studio mode: the studio listener reports what it hears and
   * sees (studio_live), its camera and the pulse; null when it does not (studio
   * mode off, nobody watching, page gone).
   */
  studioLive: { status: StudioLiveStatus; speaking: boolean; faceWorker: StudioFaceWorkerStatus | null; at: number } | null;
  studioFrame: { src: string; width: number; height: number } | null;
  studioPulse: StudioPulse | null;
  /** Where the dashboard reads the studio camera itself (a site stream over WHEP); null: relayed pictures only. */
  studioCameraUrl: string | null;
  /** The dashboard shows the studio camera now (studio_watch video). */
  studioVideoWanted: boolean;
  /** The last face observation from whichever producer runs (docs/face-service.md). */
  studioObservation: FaceObservation | null;
  controlSpeakText: string;
  chatComposerText: string;
  /** Perform mode (Z): status bar and dock hidden, the face gets the screen. */
  uiHidden: boolean;
  debugOverlayActive?: boolean;
  fullscreenActive: boolean;
  dockTab: DockTab;
  /** Where E / Escape go back to when the FX tab closes. */
  dockReturn: { tab: DockTab; folded: boolean; uiHidden: boolean };
  dockFolded: boolean;
  dockWidth: number | null;
  stage: StagePrefs;
  peers: WindowPeers;
  /** Dashboard only: whether the face window is in perform mode; null until it reports. */
  facePerform: boolean | null;
  /** Video recording of the face window (R), see audio/screen-recorder.ts. */
  screenRecording: ScreenRecordingPhase;
  screenRecordingSince: number | null;
  /** The last saved recording's file name, for "Show in Finder". */
  screenRecordingFile: string | null;
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
export const UI_PREFS_STORAGE_KEY = 'tubs.uiPrefs';
export const DASHBOARD_UI_PREFS_STORAGE_KEY = 'tubs.uiPrefs.dashboard';
export const STAGE_PREFS_STORAGE_KEY = 'tubs.stagePrefs';

/**
 * Layout choices an operator expects to survive a reload. Each view keeps its
 * own (the face window's perform mode must not follow the dashboard's layout).
 */
type UiPrefs = Pick<AppState, 'uiHidden' | 'dockTab' | 'dockFolded' | 'dockWidth'>;

export const DEFAULT_STAGE_PREFS: StagePrefs = {
  subtitles: true,
  transcript: true,
  listening: true,
  miniTile: true,
  miniPlacement: 'bottom-right',
  miniSize: 'medium',
};

function readStorage(key: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: layout just won't persist.
  }
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

export function parseUiPrefs(stored: Record<string, unknown>): Partial<UiPrefs> {
  return {
    ...(typeof stored.uiHidden === 'boolean' ? { uiHidden: stored.uiHidden } : {}),
    ...(isOneOf(DOCK_TABS, stored.dockTab) ? { dockTab: stored.dockTab } : {}),
    ...(typeof stored.dockFolded === 'boolean' ? { dockFolded: stored.dockFolded } : {}),
    ...(typeof stored.dockWidth === 'number' && Number.isFinite(stored.dockWidth) ? { dockWidth: stored.dockWidth } : {}),
  };
}

/** Missing or unknown values fall back one by one, so prefs added later start at their default. */
export function parseStagePrefs(stored: Record<string, unknown>): StagePrefs {
  const flag = (key: 'subtitles' | 'transcript' | 'listening' | 'miniTile') => (
    typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_STAGE_PREFS[key]
  );
  return {
    subtitles: flag('subtitles'),
    transcript: flag('transcript'),
    listening: flag('listening'),
    miniTile: flag('miniTile'),
    miniPlacement: isOneOf(MINI_TILE_PLACEMENTS, stored.miniPlacement) ? stored.miniPlacement : DEFAULT_STAGE_PREFS.miniPlacement,
    miniSize: isOneOf(MINI_TILE_SIZES, stored.miniSize) ? stored.miniSize : DEFAULT_STAGE_PREFS.miniSize,
  };
}

/**
 * The tab saved for a reload. Never the FX editor: while it is open the face
 * shows its true colours and never falls asleep, which an unattended
 * installation must not boot into.
 */
export function persistedDockTab(state: Pick<AppState, 'dockTab' | 'dockReturn'>): DockTab {
  return state.dockTab === 'fx' ? state.dockReturn.tab : state.dockTab;
}

/** Saves the layout prefs whenever they change, under this view's key. */
export function persistUiPrefs(store: AppStore, storageKey: string): () => void {
  return store.subscribeSelector(
    (state): UiPrefs => ({
      uiHidden: state.uiHidden,
      dockTab: persistedDockTab(state),
      dockFolded: state.dockFolded,
      dockWidth: state.dockWidth,
    }),
    (prefs) => writeStorage(storageKey, prefs),
    {
      equalityFn: (a, b) => a.uiHidden === b.uiHidden && a.dockTab === b.dockTab && a.dockFolded === b.dockFolded && a.dockWidth === b.dockWidth,
    },
  );
}

/**
 * Saves the stage prefs and follows changes made in other windows (the
 * browser fires 'storage' only in the windows that did not write).
 */
export function syncStagePrefs(store: AppStore): () => void {
  const unsubscribe = store.subscribeSelector(
    (state) => state.stage,
    (stage) => writeStorage(STAGE_PREFS_STORAGE_KEY, stage),
  );
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STAGE_PREFS_STORAGE_KEY) return;
    let stored: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(event.newValue ?? '{}');
      if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
    } catch {
      // A broken value falls back to the defaults below.
    }
    store.setState((current) => ({ ...current, stage: parseStagePrefs(stored) }));
  };
  window.addEventListener('storage', onStorage);
  return () => {
    unsubscribe();
    window.removeEventListener('storage', onStorage);
  };
}

/** @param uiPrefsKey where this view's layout prefs live; omitted for views without a HUD. */
/**
 * ?tab=<id>: the dock tab a link opens (the sentient panel's pulse bar opens
 * &tab=people), if it is a tab this view has; null otherwise.
 */
export function tabFromUrl(search: string, allowed: readonly DockTab[]): DockTab | null {
  const tab = new URLSearchParams(search).get('tab');
  return isOneOf(DOCK_TABS, tab) && allowed.includes(tab) ? tab : null;
}

export function createAppStore(uiPrefsKey?: string, options: { tab?: DockTab | null } = {}): AppStore {
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
    studioLive: null,
    studioFrame: null,
    studioPulse: null,
    studioCameraUrl: null,
    studioVideoWanted: false,
    studioObservation: null,
    faceDetectionDelayMs: 0,
    ttsRenderingSince: null,
    controlSpeakText: '',
    chatComposerText: '',
    uiHidden: false,
    fullscreenActive: false,
    dockTab: 'chat',
    dockReturn: { tab: 'chat', folded: false, uiHidden: false },
    dockFolded: false,
    dockWidth: null,
    stage: DEFAULT_STAGE_PREFS,
    peers: { face: false, mini: false, dashboard: false },
    facePerform: null,
    screenRecording: 'idle',
    screenRecordingSince: null,
    screenRecordingFile: null,
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
  if (uiPrefsKey) {
    Object.assign(initialState, parseUiPrefs(readStorage(uiPrefsKey)), {
      stage: parseStagePrefs(readStorage(STAGE_PREFS_STORAGE_KEY)),
    });
    initialState.dockReturn = { tab: initialState.dockTab, folded: initialState.dockFolded, uiHidden: initialState.uiHidden };
  }
  // A tab asked for in the link wins over the stored one, with the dock open.
  if (options.tab) {
    initialState.dockTab = options.tab;
    initialState.dockFolded = false;
    initialState.dockReturn = { tab: options.tab, folded: false, uiHidden: initialState.uiHidden };
  }
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

