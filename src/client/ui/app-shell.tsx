
import { ConnectionPanel } from './panels/ConnectionPanel.js';
import { VoicePanel } from './panels/VoicePanel.js';
import { FacePanel } from './panels/FacePanel.js';
import { StatsPanel } from './panels/StatsPanel.js';
import { ChatPanel } from './panels/ChatPanel.js';
import { PanelHeader } from './panels/PanelHeader.js';
import { formatCurrency, formatUptime, formatAwakeElapsed, formatTimestamp, resolveChatActor, renderChatPrefix, isChatEntryVisible } from './utils/formatters.js';
import { useCallback, useRef, useState, useEffect, memo, type JSX } from 'react';
import type {
  DonationConfirmRequest,
  DonationConfirmResponse,
  ManualTurnScriptRequest,
  ManualTurnScriptResponse,
  OkResponse,
  SpeakRequest,
  SpeakResponse,
} from '../../shared/contracts/http.js';
import type { TurnActor, TurnAction, TurnBeat } from '../../shared/contracts/turn-script.js';
import type { EmotionCue, ExpressionName } from '../../shared/contracts/config.js';
import type { FaceEnrollmentProgress, FaceEnrollmentResult } from '../face/runtime.js';
import type { AppState, AppStore, PanelKey } from '../state/app-state.js';
import { postJson } from '../transport/http.js';
import { patchConfig, toggleFxEditor } from '../fx/runtime.js';
import { FxEditor } from './panels/FxEditor.js';

import { useAppSelector } from './react-store.js';
import { openMiniWindow, toggleFullscreen } from './window-runtime.js';

export interface AppShellProps {
  mode: 'main' | 'mini' | 'spectator';
  store: AppStore;
  controls?: AppShellControls | undefined;
}

export interface AppShellControls {
  ambient?: {
    toggleEnabled(): Promise<void>;
  };
  voice?: {
    enableMic(): Promise<void>;
    startManualRecording(): Promise<void>;
    stopManualRecording(): void;
  } | undefined;
  face?: {
    toggleCamera(): Promise<void>;
    detectFile(file: File): Promise<void>;
    saveDetectedFace(): Promise<void>;
    enrollFace(name: string, onProgress?: (progress: FaceEnrollmentProgress) => void): Promise<FaceEnrollmentResult>;
    refreshLibrary(): Promise<void>;
    renameFace(id: string, name: string): Promise<void>;
    deleteFace(id: string): Promise<void>;
  } | undefined;
}

export function AppShell(props: AppShellProps): JSX.Element {
  if (props.mode === 'spectator') {
    return <SpectatorAppShell store={props.store} />;
  }
  return props.mode === 'mini'
    ? <MiniAppShell store={props.store} />
    : <MainAppShell store={props.store} {...(props.controls ? { controls: props.controls } : {})} />;
}

// Single-letter shortcuts; typing any other letter focuses the chat input.
const SHORTCUT_KEYS = new Set([' ', 'c', 'd', 'e', 'f', 'm', 'o', 's', 'x', 'z']);

function MainAppShell({ store, controls }: { store: AppStore; controls?: AppShellControls }): JSX.Element {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      
      const key = e.key.toLowerCase();

      if (store.getState().fxEditorOpen) {
        // Escape is handled by window-runtime; everything else waits for the editor to close.
        if (!inInput && key === 'e') {
          e.preventDefault();
          toggleFxEditor(store);
        }
        return;
      }

      // Non-input strict binds
      if (!inInput) {
        if (key === 'e') {
          e.preventDefault();
          toggleFxEditor(store);
        } else if (key === 'm') {
          e.preventDefault();
          void patchConfig(store, { muted: !store.getState().config?.muted });
        } else if (key === 's') {
          e.preventDefault();
          const isSleep = store.getState().sleeping;
          void postJson(isSleep ? '/wake' : '/sleep', {});
        } else if (key === 'c') {
          e.preventDefault();
          void controls?.face?.toggleCamera();
        } else if (key === 'f') {
          e.preventDefault();
          if (!store.getState().faceCameraActive) return;
          const name = window.prompt("Enter name for Face Enrollment:");
          if (name?.trim()) {
             store.setState(s => ({ ...s, faceDraftName: name.trim() }));
             void controls?.face?.enrollFace(name.trim());
          }
        } else if (key === 'd') {
          e.preventDefault();
          store.setState(s => ({ ...s, debugOverlayActive: !s.debugOverlayActive }));
        } else if (key === 'enter') {
           // Allow starting to type immediately by focusing the chat input?
           // The user says "Type any characters, then Enter". 
           // If they hit Enter while NOT in input, maybe we focus logic?
           document.getElementById('chat-panel-input')?.focus();
        }
      }
    };
    
    // Key presses on letter keys (if not in input) should focus the chat so users can just type text.
    const handleTypeFocus = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (store.getState().fxEditorOpen) return;
      if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !SHORTCUT_KEYS.has(e.key.toLowerCase())) {
        const input = document.getElementById('chat-panel-input') as HTMLInputElement | null;
        if (input) {
          input.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKey);
    window.addEventListener('keydown', handleTypeFocus);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('keydown', handleTypeFocus);
    };
  }, [store, controls]);

  const shellState = useAppSelector(store, (state) => ({
    uiHidden: state.uiHidden,
    fullscreenActive: state.fullscreenActive,
    fxEditorOpen: state.fxEditorOpen,
  }));

  return (
    <main className={`shell shell-main ${shellState.uiHidden ? 'shell-ui-hidden' : ''} ${shellState.fullscreenActive ? 'fullscreen-active' : ''} ${shellState.fxEditorOpen ? 'fx-editor-open' : ''}`}>
      <VisualShell store={store} mode="main" />

      {!shellState.uiHidden && !shellState.fxEditorOpen && (
        <div className="hud-layer">
          <div className="hud-stack hud-stack-top-left">
            <ConnectionPanel store={store} />
            <VoicePanel store={store} controls={controls} />
            <StatsPanel store={store} />
          </div>

          <div className="hud-corner hud-corner-bottom-left">
            <ChatPanel store={store} />
          </div>

          <div className="hud-corner hud-corner-top-right">
            <TopBar store={store} />
          </div>

          <div className="hud-stack hud-stack-bottom-right">
            <FacePanel store={store} {...(controls?.face ? { controls: controls.face } : {})} />
          </div>
        </div>
      )}

      <FxEditor store={store} />

      {/* Hidden Legacy Panels (Preserved for React State/Logic bindings) */}
      <div className="hidden">
        <HealthPanel store={store} />
        <ConfigPanel store={store} />
        <AssistantPanel store={store} />
        <ControlsPanel store={store} {...(controls ? { controls } : {})} />
        <ManualPanel store={store} />
        <StreamDebugPanel store={store} />
        <EventLogPanel store={store} />
      </div>
    </main>
  );
}

function MiniAppShell({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    sleeping: current.sleeping,
    currentReactionEmoji: current.currentReactionEmoji,
    liveTranscriptText: current.liveTranscriptText,
    liveTranscriptDraft: current.liveTranscriptDraft,
    config: current.config,
  }));

  return (
    <main className="mini-shell">
      <section className={`visual-shell mini-visual-shell ${state.sleeping ? 'is-sleeping' : ''}`}>
        <div className="visual-stage">
          <div className="visual-face-frame mini-visual-frame">
            {/* Face div is static — visual-runtime.ts manages all attributes imperatively */}
            <StableFaceContainer id="visual-face" className="visual-face mini-visual-face" />
          </div>
        </div>
        <div
          className={`mini-reaction ${state.currentReactionEmoji ? 'is-visible' : ''}`}
          aria-hidden={!state.currentReactionEmoji}
        >
          {state.currentReactionEmoji}
        </div>
        <div
          id="visual-live-transcript"
          className={`visual-live-transcript ${state.liveTranscriptText.trim() ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
        >
          {state.liveTranscriptText}
        </div>
        <div
          id="visual-subtitle"
          className={`visual-subtitle ${state.sleeping || state.config?.secondarySubtitleEnabled === false ? 'is-hidden' : ''}`}
        />
      </section>
    </main>
  );
}

function SpectatorAppShell({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    sleeping: current.sleeping,
    connected: current.connected,
  }));
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const unlockFiredRef = useRef(false);

  const handleTap = useCallback(() => {
    // Guard with ref so we fire exactly once, even if React state hasn't re-rendered yet.
    if (unlockFiredRef.current) return;
    unlockFiredRef.current = true;
    // Dispatch event so bootstrap can unlock the speech runtime's AudioContext.
    // This is synchronous, keeping us inside the user-gesture call stack.
    window.dispatchEvent(new CustomEvent('tubs:unlock-audio'));
    setAudioUnlocked(true);
  }, []);

  return (
    <main
      className="mini-shell spectator-shell"
      onClick={handleTap}
      onTouchEnd={handleTap}
    >
      <section className={`visual-shell mini-visual-shell ${state.sleeping ? 'is-sleeping' : ''}`}>
        <div className="visual-stage">
          <div className="visual-face-frame mini-visual-frame">
            <StableFaceContainer id="visual-face" className="visual-face mini-visual-face" />
          </div>
        </div>
        <div
          id="visual-subtitle"
          className={`visual-subtitle spectator-subtitle ${state.sleeping ? 'is-hidden' : ''}`}
        />
        {!state.connected && (
          <div className="spectator-status">Connecting...</div>
        )}
        {state.connected && !audioUnlocked && (
          <div className="spectator-tap-prompt">Tap to enable audio</div>
        )}
      </section>
    </main>
  );
}

function TopBar({ store }: { store: AppStore }): JSX.Element {
  const fullscreenActive = useAppSelector(store, (state) => state.fullscreenActive);
  return (
    <div className="top-bar">
      <button
        id="window-open-mini"
        className="button button-secondary button-compact"
        type="button"
        onClick={() => {
          openMiniWindow(store, true);
        }}
      >
        Mini
      </button>
      <button
        id="window-fullscreen"
        className="button button-compact"
        type="button"
        onClick={async () => {
          await toggleFullscreen(store);
        }}
      >
        {fullscreenActive ? 'Exit FS' : 'Fullscreen'}
      </button>
    </div>
  );
}

/**
 * Absolutely stable face container — never re-renders.
 * All visual attributes (expression, gaze, render-mode, sleep, blink)
 * are managed imperatively by visual-runtime.ts and glitch/runtime.ts.
 * Keeping this out of React's reconciliation tree prevents the canvas
 * from being disrupted when overlays (transcript, waveform) update.
 */
const StableFaceContainer = memo(
  function StableFaceContainer({ id, className }: { id: string; className: string }): JSX.Element {
    return (
      <div
        id={id}
        className={className}
        data-render-mode="glitch"
      />
    );
  },
  // Never re-render — props don't change and all DOM updates are imperative
  () => true,
);

/** Overlays that sit on top of the face (transcript, waveform, donation) */
function VisualOverlays({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    sleeping: current.sleeping,
    liveTranscriptText: current.liveTranscriptText,
    liveTranscriptDraft: current.liveTranscriptDraft,
    currentDonationSignal: current.currentDonationSignal,
    micLevel: current.micLevel,
    recording: current.recording,
    listenState: current.listenState,
    voiceWakeWordEnabled: current.voiceWakeWordEnabled,
    voiceHandsFreeEnabled: current.voiceHandsFreeEnabled,
    conversationActive: current.conversationActive,
  }));
  const donationVisible = Boolean(state.currentDonationSignal) && !state.sleeping;

  return (
    <>
      <div className="visual-overlay visual-overlay-top-left">
        <div id="visual-donation-card" className={`visual-donation-card ${donationVisible ? 'is-visible' : ''}`}>
          {donationVisible ? <img id="visual-donation-qr" alt="Donation QR" src={DONATION_QR_SRC} /> : null}
          <div className="visual-donation-copy">
            <strong id="visual-donation-handle">Venmo {DONATION_VENMO_HANDLE}</strong>
            <span id="visual-donation-amount">{formatDonationFromSignal(state.currentDonationSignal)}</span>
          </div>
        </div>
      </div>

      <div className="visual-overlay visual-overlay-bottom">
        <div id="visual-subtitle" className={`visual-subtitle ${state.sleeping ? 'is-hidden' : ''}`} />
        <div
          id="visual-live-transcript"
          className={`visual-live-transcript ${state.liveTranscriptText.trim() ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
        >
          {state.liveTranscriptText}
        </div>
        <VoiceWaveformIndicator
          micLevel={state.micLevel}
          recording={state.recording}
          listenState={state.listenState}
          conversationActive={state.conversationActive}
          voiceWakeWordEnabled={state.voiceWakeWordEnabled}
          voiceHandsFreeEnabled={state.voiceHandsFreeEnabled}
          hidden={state.sleeping}
        />
        <CompactAssistantStatus store={store} />
      </div>
    </>
  );
}

function VisualShell({ store, mode }: { store: AppStore; mode: 'main' | 'mini' }): JSX.Element {
  const sleeping = useAppSelector(store, (current) => current.sleeping);
  const shellClassName = mode === 'mini' ? 'visual-shell mini-visual-shell' : 'visual-shell main-visual-shell';
  const faceClassName = mode === 'mini' ? 'visual-face mini-visual-face' : 'visual-face main-visual-face';

  return (
    <section className={`${shellClassName} ${sleeping ? 'is-sleeping' : ''}`}>
      <div className="visual-stage">
        <div className={`visual-face-frame ${mode === 'mini' ? 'mini-visual-frame' : 'main-visual-frame'}`}>
          {/* Face div is completely isolated — no re-renders from overlay state changes */}
          <StableFaceContainer id="visual-face" className={faceClassName} />
        </div>
      </div>
      {mode === 'main' ? <VisualOverlays store={store} /> : null}
    </section>
  );
}

function VoiceWaveformIndicator(props: {
  micLevel: number;
  recording: boolean;
  listenState: string;
  conversationActive: boolean;
  voiceWakeWordEnabled: boolean;
  voiceHandsFreeEnabled: boolean;
  hidden: boolean;
}): JSX.Element {
  const bars = Array.from({ length: 20 }, (_, index) => {
    const normalizedLevel = Math.max(0.02, Math.min(1, props.micLevel));
    const centerBias = 1 - Math.abs(index - 9.5) / 10.5;
    const seeded = ((index * 17) % 11) / 10;
    const height = 6 + Math.round((normalizedLevel * 26 * (0.45 + centerBias * 0.9)) + (seeded * 6));
    return (
      <span
        key={index}
        className="visual-wave-bar"
        style={{ height: `${Math.max(6, Math.min(34, height))}px` }}
      />
    );
  });

  const mode = resolveWaveformMode(props);
  const label = resolveWaveformLabel(props, mode);

  return (
    <div className={`visual-wave-shell visual-wave-${mode} ${props.hidden ? 'is-hidden' : ''}`}>
      <div className="visual-waveform" aria-hidden="true">
        {bars}
      </div>
      <div className="visual-wave-label">{label}</div>
    </div>
  );
}

function resolveWaveformMode(props: {
  recording: boolean;
  listenState: string;
  conversationActive: boolean;
  voiceWakeWordEnabled: boolean;
  voiceHandsFreeEnabled: boolean;
}): 'idle' | 'always-on' | 'wake' | 'conversation' | 'transcribing' | 'recording' {
  if (props.recording) {
    return 'recording';
  }
  if (props.listenState === 'Uploading...' || props.listenState === 'Thinking...') {
    return 'transcribing';
  }
  if (props.conversationActive) {
    return 'conversation';
  }
  if (props.voiceHandsFreeEnabled && props.voiceWakeWordEnabled) {
    return 'wake';
  }
  if (props.voiceHandsFreeEnabled) {
    return 'always-on';
  }
  return 'idle';
}

function resolveWaveformLabel(
  props: {
    listenState: string;
    voiceWakeWordEnabled: boolean;
    voiceHandsFreeEnabled: boolean;
  },
  mode: ReturnType<typeof resolveWaveformMode>,
): string {
  if (mode === 'recording' || mode === 'transcribing') {
    return props.listenState;
  }
  if (mode === 'conversation') {
    return 'Conversation Open';
  }
  if (mode === 'wake') {
    return 'Wake Word Armed';
  }
  if (mode === 'always-on') {
    return props.voiceWakeWordEnabled ? 'Always Listening' : 'Always On';
  }
  return 'Push To Talk';
}

function CompactAssistantStatus({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    sleeping: current.sleeping,
    currentExpression: current.currentExpression,
    lastMessageType: current.lastMessageType,
    config: current.config,
    conversationActive: current.conversationActive,
  }));

  if (state.sleeping || !state.config) return <></>;

  const dualEnabled = state.config.dualHeadEnabled && state.config.dualHeadMode !== 'off';
  const miniStatus = state.conversationActive ? 'active' : 'idle';

  return (
    <div className="compact-sys-status">
      <span className="compact-sys-badge">
        <span className="compact-sys-label">LV</span>
        <span className="compact-sys-value">{state.lastMessageType}</span>
      </span>
      <span className="compact-sys-badge">
        <span className="compact-sys-label">MN</span>
        <span className="compact-sys-value">{state.currentExpression}</span>
      </span>
      {dualEnabled && (
        <span className="compact-sys-badge">
          <span className="compact-sys-label">SM</span>
          <span className="compact-sys-value">{miniStatus}</span>
        </span>
      )}
    </div>
  );
}

function HealthPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.health),
    health: current.health,
  }));

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="health" title="Health" meta={state.health?.status ?? 'unknown'} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <dl className="kv">
          <div><dt>Status</dt><dd>{state.health?.status ?? 'unknown'}</dd></div>
          <div><dt>Mode</dt><dd>{state.health?.processingMode ?? 'n/a'}</dd></div>
          <div><dt>Clients</dt><dd>{state.health?.clients ?? 0}</dd></div>
          <div><dt>Uptime</dt><dd>{formatUptime(state.health)}</dd></div>
        </dl>
      </div>
    </article>
  );
}

function ConfigPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.config),
    config: current.config,
    ambientAudioEnabled: current.ambientAudioEnabled,
  }));
  const faceRenderMode = state.config?.faceRenderMode ?? 'glitch';
  const renderQuality = state.config?.renderQuality ?? 'high';

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="config" title="Config" meta={state.config?.llmModel ?? 'n/a'} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <dl className="kv">
          <div><dt>Model</dt><dd>{state.config?.llmModel ?? 'n/a'}</dd></div>
          <div><dt>Render</dt><dd>{faceRenderMode}</dd></div>
          <div><dt>Quality</dt><dd>{renderQuality}</dd></div>
          <div><dt>Muted</dt><dd>{state.config?.muted ? 'yes' : 'no'}</dd></div>
          <div><dt>Ambient</dt><dd>{state.ambientAudioEnabled ? 'on' : 'off'}</dd></div>
        </dl>
      </div>
    </article>
  );
}

function AssistantPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.assistant),
    currentExpression: current.currentExpression,
    sleeping: current.sleeping,
    conversationActive: current.conversationActive,
    awakeElapsedSec: current.awakeElapsedSec,
    currentTurnId: current.currentTurnId,
    moodPos: current.moodPos,
    moodNeg: current.moodNeg,
    moodArousal: current.moodArousal,
  }));

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="assistant" title="Assistant" meta={state.currentExpression} metaId="assistant-panel-meta" />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <dl className="kv">
          <div><dt>Expression</dt><dd id="assistant-expression-value">{state.currentExpression}</dd></div>
          <div><dt>Sleep</dt><dd id="assistant-sleep-value">{state.sleeping ? 'asleep' : 'awake'}</dd></div>
          <div><dt>Conversation</dt><dd id="assistant-conversation-value">{state.conversationActive ? 'active' : 'idle'}</dd></div>
          <div><dt>Awake</dt><dd id="assistant-awake-value">{formatAwakeElapsed(state.awakeElapsedSec)}</dd></div>
          <div><dt>Turn</dt><dd id="assistant-turn-value">{state.currentTurnId ?? 'n/a'}</dd></div>
          <div><dt>Mood</dt><dd id="assistant-mood-value">{state.moodPos.toFixed(2)} / {state.moodNeg.toFixed(2)} / {state.moodArousal.toFixed(2)}</dd></div>
        </dl>
      </div>
    </article>
  );
}

function ControlsPanel({
  store,
  controls,
}: {
  store: AppStore;
  controls?: AppShellControls;
}): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.controls),
    chatVerbosity: current.chatVerbosity,
    ambientAudioEnabled: current.ambientAudioEnabled,
    sleeping: current.sleeping,
    controlSpeakText: current.controlSpeakText,
    controlDonationAmount: current.controlDonationAmount,
  }));

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="controls" title="Controls" meta="Actions" />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <div className="face-actions">
          <div className="face-action-row">
            <button
              id="chat-verbosity-toggle"
              className={`button button-secondary button-compact ${state.chatVerbosity === 'all' ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                store.setState((current) => ({
                  ...current,
                  chatVerbosity: current.chatVerbosity === 'all'
                    ? 'chat'
                    : current.chatVerbosity === 'chat'
                      ? 'minimal'
                      : 'all',
                }));
              }}
            >
              Verbosity {state.chatVerbosity.toUpperCase()}
            </button>
            <button
              id="ambient-toggle"
              className={`button button-secondary button-compact ${state.ambientAudioEnabled ? 'is-active' : ''}`}
              type="button"
              onClick={async () => {
                await controls?.ambient?.toggleEnabled();
              }}
            >
              Ambient {state.ambientAudioEnabled ? 'On' : 'Off'}
            </button>
            <button
              id="action-wake"
              className="button button-secondary button-compact"
              type="button"
              onClick={async () => {
                await runControlAction(store, 'Wake', () => postJson<undefined, OkResponse>('/wake'));
              }}
            >
              {state.sleeping ? 'Wake' : 'Awake'}
            </button>
            <button
              id="action-sleep"
              className="button button-secondary button-compact"
              type="button"
              onClick={async () => {
                await runControlAction(store, 'Sleep', () => postJson<undefined, OkResponse>('/sleep'));
              }}
            >
              {state.sleeping ? 'Sleeping' : 'Sleep'}
            </button>
          </div>
          <div className="face-action-row">
            <input
              id="action-speak-text"
              className="face-name-input"
              type="text"
              placeholder="Inject statement"
              value={state.controlSpeakText}
              onChange={(event) => {
                const value = event.currentTarget.value;
                store.setState((current) => ({
                  ...current,
                  controlSpeakText: value,
                }));
              }}
            />
            <button
              id="action-speak"
              className="button button-compact"
              type="button"
              onClick={async () => {
                const text = store.getState().controlSpeakText.trim();
                if (!text) {
                  store.appendLog('error', 'Enter text before using Speak');
                  return;
                }
                await runControlAction(store, 'Speak', async () => {
                  await postJson<SpeakRequest, SpeakResponse>('/speak', { text });
                  store.setState((current) => ({
                    ...current,
                    controlSpeakText: '',
                  }));
                });
              }}
            >
              Speak
            </button>
            <input
              id="action-donation-amount"
              className="face-name-input"
              type="text"
              placeholder="$ Amount"
              value={state.controlDonationAmount}
              onChange={(event) => {
                const value = event.currentTarget.value;
                store.setState((current) => ({
                  ...current,
                  controlDonationAmount: value,
                }));
              }}
            />
            <button
              id="action-donate"
              className="button button-compact"
              type="button"
              onClick={async () => {
                const amount = store.getState().controlDonationAmount.trim();
                await runControlAction(store, 'Donation', () => postJson<DonationConfirmRequest, DonationConfirmResponse>('/donations/confirm', {
                  certainty: 'confident',
                  source: 'react-client-shell',
                  ...(amount ? { amount, currency: 'USD' } : {}),
                }));
              }}
            >
              Signal Donation
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function ManualPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.manual),
    manualComposerOpen: current.manualComposerOpen,
    manualComposerMode: current.manualComposerMode,
    manualActor: current.manualActor,
    manualAction: current.manualAction,
    manualExpression: current.manualExpression,
    manualEmoji: current.manualEmoji,
    manualDelay: current.manualDelay,
    manualText: current.manualText,
    manualScript: current.manualScript,
    manualStatus: current.manualStatus,
    manualStatusKind: current.manualStatusKind,
    manualSending: current.manualSending,
  }));

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="manual" title="Manual Beats" meta={state.manualStatus} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <div className="manual-beats-row">
          <button
            id="manual-beats-toggle"
            className="button button-secondary"
            type="button"
            onClick={() => {
              store.setState((current) => ({
                ...current,
                manualComposerOpen: !current.manualComposerOpen,
              }));
            }}
          >
            {state.manualComposerOpen ? 'Close' : 'Open'}
          </button>
          <select
            id="manual-beats-mode"
            className="mini-select"
            value={state.manualComposerMode}
            onChange={(event) => {
              const value = event.currentTarget.value === 'script' ? 'script' : 'single';
              store.setState((current) => ({
                ...current,
                manualComposerMode: value,
                manualStatus: 'Ready',
                manualStatusKind: 'idle',
              }));
            }}
          >
            <option value="single">Single Beat</option>
            <option value="script">Script JSON</option>
          </select>
        </div>
        <div className={`manual-beats-shell ${state.manualComposerOpen ? 'is-open' : ''}`}>
          <div id="manual-single-fields" className={`manual-fields-grid ${state.manualComposerMode === 'script' ? 'is-hidden' : ''}`}>
            <div className="manual-beats-row">
              <label className="manual-field">
                <span>Actor</span>
                <select
                  id="manual-beat-actor"
                  className="mini-select"
                  value={state.manualActor}
                  onChange={(event) => {
                    const value = event.currentTarget.value === 'small' ? 'small' : 'main';
                    store.setState((current) => ({
                      ...current,
                      manualActor: value,
                    }));
                  }}
                >
                  <option value="main">Main</option>
                  <option value="small">Small</option>
                </select>
              </label>
              <label className="manual-field">
                <span>Action</span>
                <select
                  id="manual-beat-action"
                  className="mini-select"
                  value={state.manualAction}
                  onChange={(event) => {
                    store.setState((current) => ({
                      ...current,
                      manualAction: normalizeManualAction(event.currentTarget.value),
                    }));
                  }}
                >
                  <option value="speak">Speak</option>
                  <option value="react">React</option>
                  <option value="wait">Wait</option>
                </select>
              </label>
            </div>
            <div className="manual-beats-row">
              <label className="manual-field">
                <span>Expression</span>
                <input
                  id="manual-beat-expression"
                  className="face-name-input"
                  type="text"
                  value={state.manualExpression}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    store.setState((current) => ({
                      ...current,
                      manualExpression: value,
                    }));
                  }}
                />
              </label>
              <label className="manual-field">
                <span>Emoji</span>
                <input
                  id="manual-beat-emoji"
                  className="face-name-input"
                  type="text"
                  value={state.manualEmoji}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    store.setState((current) => ({
                      ...current,
                      manualEmoji: value,
                    }));
                  }}
                />
              </label>
            </div>
            <div className="manual-beats-row">
              <label className="manual-field">
                <span>Delay Ms</span>
                <input
                  id="manual-beat-delay"
                  className="face-name-input"
                  type="text"
                  value={state.manualDelay}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    store.setState((current) => ({
                      ...current,
                      manualDelay: value,
                    }));
                  }}
                />
              </label>
            </div>
            <label className="manual-field">
              <span>Text</span>
              <textarea
                id="manual-beat-text"
                className="manual-textarea"
                rows={4}
                value={state.manualText}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store.setState((current) => ({
                    ...current,
                    manualText: value,
                  }));
                }}
                onKeyDown={async (event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    await submitManualBeats(store);
                  }
                }}
              />
            </label>
          </div>
          <div id="manual-script-fields" className={state.manualComposerMode === 'script' ? '' : 'is-hidden'}>
            <label className="manual-field">
              <span>Script JSON</span>
              <textarea
                id="manual-script-json"
                className="manual-textarea"
                rows={10}
                value={state.manualScript}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store.setState((current) => ({
                    ...current,
                    manualScript: value,
                  }));
                }}
                onKeyDown={async (event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    await submitManualBeats(store);
                  }
                }}
              />
            </label>
          </div>
          <div className="manual-beats-actions">
            <button
              id="manual-beats-send"
              className="button"
              type="button"
              disabled={state.manualSending}
              onClick={async () => {
                await submitManualBeats(store);
              }}
            >
              {state.manualSending ? 'Sending...' : 'Send'}
            </button>
            <button
              id="manual-beats-template"
              className="button button-secondary"
              type="button"
              onClick={() => {
                applyManualTemplate(store);
              }}
            >
              Valentine
            </button>
            <button
              id="manual-beats-clear"
              className="button button-secondary"
              type="button"
              onClick={() => {
                store.setState((current) => ({
                  ...current,
                  manualExpression: '',
                  manualEmoji: '',
                  manualDelay: '',
                  manualText: '',
                  manualScript: '',
                  manualStatus: 'Cleared',
                  manualStatusKind: 'idle',
                }));
              }}
            >
              Clear
            </button>
          </div>
          <div className={`manual-beats-status ${renderManualStatusClass(state.manualStatusKind)}`}>{state.manualStatus}</div>
        </div>
      </div>
    </article>
  );
}

function StreamDebugPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.streamDebug),
    streamDebug: current.streamDebug,
  }));
  const debug = state.streamDebug;

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader
        store={store}
        panelKey="streamDebug"
        title="Stream Debug"
        meta={debug.enabled ? (debug.currentTurnId?.slice(0, 8) ?? 'none') : 'disabled'}
        metaId="stream-debug-panel-meta"
      />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <div className="face-action-row">
          <button
            id="stream-debug-toggle"
            className="button button-secondary"
            type="button"
            onClick={() => {
              store.setState((current) => {
                const enabled = !current.streamDebug.enabled;
                try {
                  window.localStorage.setItem('tubs.streamDebugEnabled', enabled ? '1' : '0');
                } catch {
                  // ignore
                }
                return {
                  ...current,
                  streamDebug: {
                    ...current.streamDebug,
                    enabled,
                  },
                };
              });
            }}
          >
            {debug.enabled ? 'Disable Debug' : 'Enable Debug'}
          </button>
          <button
            id="stream-debug-clear"
            className="button button-secondary"
            type="button"
            onClick={() => {
              store.setState((current) => ({
                ...current,
                streamDebug: {
                  ...current.streamDebug,
                  entries: [],
                  llmDeltas: 0,
                  llmChars: 0,
                  sentences: 0,
                  ttsSentences: 0,
                  ttsChars: 0,
                  audioChunksIn: 0,
                  audioBytesIn: 0,
                  audioChunksPlayed: 0,
                  audioSecondsPlayed: 0,
                },
              }));
            }}
          >
            Clear
          </button>
        </div>
        <dl className="kv">
          <div><dt>LLM</dt><dd id="stream-debug-llm-value">{debug.llmDeltas}/{debug.llmChars}</dd></div>
          <div><dt>Sentences</dt><dd id="stream-debug-sentences-value">{debug.sentences}</dd></div>
          <div><dt>TTS Out</dt><dd id="stream-debug-tts-value">{debug.ttsSentences}/{debug.ttsChars}</dd></div>
          <div><dt>Audio In</dt><dd id="stream-debug-audio-in-value">{debug.audioChunksIn}/{Math.round(debug.audioBytesIn / 1024)}KB</dd></div>
          <div><dt>Played</dt><dd id="stream-debug-played-value">{debug.audioChunksPlayed}/{debug.audioSecondsPlayed.toFixed(2)}s</dd></div>
        </dl>
        <ul id="stream-debug-list" className="logs">
          {!debug.enabled && <li className="log"><span>Stream debug disabled.</span></li>}
          {debug.enabled && debug.entries.length === 0 && <li className="log"><span>No stream events yet.</span></li>}
          {debug.enabled && debug.entries.map((entry) => (
            <li key={entry.id} className="debug-entry">
              <span className="log-time">{formatTimestamp(entry.ts)}</span>
              <span>{entry.stage} {formatDebugPayload(entry.payload)}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function EventLogPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.eventLog),
    logs: current.logs,
  }));

  return (
    <article className={`${renderPanelCardClass(state.collapsed)} flex-column-card`}>
      <PanelHeader store={store} panelKey="eventLog" title="Event Log" meta={`${state.logs.length} entries`} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <ul id="event-log-list" className="logs event-log-list">
          {state.logs.length === 0
            ? <li className="log"><span>No events yet.</span></li>
            : state.logs.map((entry) => (
              <li key={entry.id} className={`log log-${entry.level}`}>
                <div className="log-meta">
                  <span className="log-time">{formatTimestamp(entry.ts)}</span>
                </div>
                <span className="log-text">{entry.text}</span>
              </li>
            ))}
        </ul>
      </div>
    </article>
  );
}

async function runControlAction(store: AppStore, label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    store.appendLog('info', `${label} request sent`);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${label} request failed`;
    store.appendLog('error', message);
  }
}

function renderPanelCardClass(collapsed: boolean): string {
  return `card panel-card ${collapsed ? 'is-collapsed' : ''}`;
}

function formatFaceSummary(state: Pick<AppState, 'faceWorkerBusy' | 'faceWorkerReady' | 'faceLastDetectedCount'>): string {
  if (state.faceWorkerBusy) return 'Running';
  if (!state.faceWorkerReady) return 'Loading worker';
  return state.faceLastDetectedCount > 0 ? `${state.faceLastDetectedCount} detected` : 'Ready';
}

function formatDebugPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([key]) => key !== 'ts')
    .slice(0, 5)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

// TODO: the handle is hardcoded; main read it from the donation payload.
const DONATION_VENMO_HANDLE = '@TubsBot';
const DONATION_QR_SRC = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(`https://venmo.com/${DONATION_VENMO_HANDLE.slice(1)}`)}`;

function formatDonationFromSignal(signal: AppState['currentDonationSignal']): string {
  if (!signal) {
    return '';
  }
  const amount = signal.amount ? `${signal.amount}${signal.currency ? ` ${signal.currency}` : ''}` : 'Wheel fund';
  return [signal.certainty.toUpperCase(), signal.donor, amount].filter(Boolean).join(' · ');
}

function renderFaceMeta(face: AppState['faceLastFaces'][number]): string {
  if (face.name) {
    return 'Recognized from library';
  }
  if (face.match?.name) {
    return `Closest match: ${face.match.name}`;
  }
  return 'No confident match';
}

function renderManualStatusClass(kind: 'idle' | 'ok' | 'error' | 'busy'): string {
  return kind === 'ok'
    ? 'is-ok'
    : kind === 'error'
      ? 'is-error'
      : kind === 'busy'
        ? 'is-busy'
        : '';
}

const SUPPORTED_EMOJI_CUES = new Set<EmotionCue>(['🙂', '😄', '😏', '🥺', '😢', '😤', '🤖', '🫶']);
const VALENTINE_TEMPLATE: ManualTurnScriptRequest = {
  beats: [
    {
      actor: 'main',
      action: 'speak',
      text: "Happy Valentine's Day, beautiful humans. Tubs is in full love mode.",
      emotion: { expression: 'love', emoji: '🫶' },
    },
    {
      actor: 'small',
      action: 'react',
      text: 'Heart lasers online.',
      emotion: { expression: 'happy', emoji: '😄' },
      delayMs: 700,
    },
    {
      actor: 'small',
      action: 'speak',
      text: 'If you feel generous today, I still accept wheel money with romance.',
      emotion: { expression: 'smile', emoji: '😏' },
    },
  ],
};

function applyManualTemplate(store: AppStore): void {
  const state = store.getState();
  if (state.manualComposerMode === 'script') {
    store.setState((current) => ({
      ...current,
      manualScript: JSON.stringify(VALENTINE_TEMPLATE, null, 2),
      manualStatus: 'Template loaded',
      manualStatusKind: 'ok',
    }));
    return;
  }

  store.setState((current) => ({
    ...current,
    manualActor: 'main',
    manualAction: 'speak',
    manualExpression: 'love',
    manualEmoji: '🫶',
    manualDelay: '',
    manualText: "Happy Valentine's Day from Tubs. Hearts, hype, and electric-wheel dreams.",
    manualStatus: 'Template loaded',
    manualStatusKind: 'ok',
  }));
}

async function submitManualBeats(store: AppStore): Promise<void> {
  store.setState((current) => ({
    ...current,
    manualSending: true,
    manualStatus: 'Sending...',
    manualStatusKind: 'busy',
  }));

  try {
    const payload = buildManualPayload(store.getState());
    const result = await postJson<ManualTurnScriptRequest, ManualTurnScriptResponse>('/turn-script/manual', payload);
    const noun = result.beatCount === 1 ? 'beat' : 'beats';
    store.setState((current) => ({
      ...current,
      manualSending: false,
      manualStatus: `Queued ${result.beatCount} ${noun} (${result.turnId})`,
      manualStatusKind: 'ok',
    }));
    store.appendLog('info', `Manual turn queued (${result.beatCount} ${noun})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to queue manual turn';
    store.setState((current) => ({
      ...current,
      manualSending: false,
      manualStatus: message,
      manualStatusKind: 'error',
    }));
    store.appendLog('error', message);
  }
}

function buildManualPayload(state: ReturnType<AppStore['getState']>): ManualTurnScriptRequest {
  if (state.manualComposerMode === 'script') {
    return parseScriptPayload(state.manualScript);
  }

  return {
    beats: [parseSingleBeat(state)],
  };
}

function parseSingleBeat(state: ReturnType<AppStore['getState']>): TurnBeat {
  const beat: TurnBeat = {
    actor: state.manualActor,
    action: state.manualAction,
  };

  const text = cleanText(state.manualText);
  if (beat.action === 'speak' && !text) {
    throw new Error('Text is required for speak beats');
  }
  if (text) {
    beat.text = text;
  }

  const delayMs = parseDelayMs(state.manualDelay);
  if (delayMs != null) {
    beat.delayMs = delayMs;
  }

  const expression = cleanText(state.manualExpression).toLowerCase();
  const emoji = cleanText(state.manualEmoji);
  if (emoji && !SUPPORTED_EMOJI_CUES.has(emoji as EmotionCue)) {
    throw new Error('Unsupported emoji cue');
  }

  if (expression || emoji) {
    beat.emotion = {
      ...(expression ? { expression: expression as ExpressionName } : {}),
      ...(emoji ? { emoji: emoji as EmotionCue } : {}),
    };
  }

  return beat;
}

function parseScriptPayload(raw: string): ManualTurnScriptRequest {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('Script JSON is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Script JSON is invalid');
  }

  if (Array.isArray(parsed)) {
    return { beats: parsed as NonNullable<ManualTurnScriptRequest['beats']> };
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as { beats?: ManualTurnScriptRequest['beats']; turn_script?: { beats?: ManualTurnScriptRequest['beats'] } };
    if (Array.isArray(record.beats)) {
      return { beats: record.beats };
    }
    if (Array.isArray(record.turn_script?.beats)) {
      return { beats: record.turn_script.beats };
    }
  }

  throw new Error('Script JSON must be an array or include beats[]');
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDelayMs(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Delay must be a number between 120 and 8000');
  }

  return Math.max(120, Math.min(8000, Math.round(parsed)));
}

function normalizeManualAction(value: string): TurnAction {
  return value === 'react' || value === 'wait' ? value : 'speak';
}
