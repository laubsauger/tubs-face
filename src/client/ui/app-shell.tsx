
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
import type { AppState, AppStore, PanelKey } from '../state/app-state.js';
import { postJson } from '../transport/http.js';
import {
  exportConfig as exportGlitchConfig,
  importConfig as importGlitchConfig,
  normalizeExpressionName,
  normalizeHex,
  patchConfig as patchFxConfig,
  patchExpressionProfile,
  previewExpression,
} from '../fx/runtime.js';
import { GLITCH_PRESETS } from '../fx/presets.js';

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
    refreshLibrary(): Promise<void>;
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

function MainAppShell({ store, controls }: { store: AppStore; controls?: AppShellControls }): JSX.Element {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      
      const key = e.key.toLowerCase();

      // Non-input strict binds
      if (!inInput) {
        if (key === 's') {
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
             void controls?.face?.saveDetectedFace();
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
      if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ' && e.key !== 'c' && e.key !== 'f' && e.key !== 'd' && e.key !== 's' && e.key !== 'z' && e.key !== 'x') {
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
  }));

  return (
    <main className={`shell shell-main ${shellState.uiHidden ? 'shell-ui-hidden' : ''} ${shellState.fullscreenActive ? 'fullscreen-active' : ''}`}>
      <VisualShell store={store} mode="main" />

      {!shellState.uiHidden && (
        <div className="hud-layer">
          <div className="hud-stack hud-stack-top-left">
            <ConnectionPanel store={store} />
            <VoicePanel store={store} controls={controls} />
          </div>

          <div className="hud-corner hud-corner-bottom-left">
            <ChatPanel store={store} />
          </div>

          <div className="hud-corner hud-corner-top-right">
            <TopBar store={store} />
          </div>

          <div className="hud-stack hud-stack-bottom-right">
            <FacePanel store={store} {...(controls?.face ? { controls: controls.face } : {})} />
            <StatsPanel store={store} />
          </div>
        </div>
      )}

      {/* Hidden Legacy Panels (Preserved for React State/Logic bindings) */}
      <div className="hidden">
        <HealthPanel store={store} />
        <ConfigPanel store={store} />
        <AssistantPanel store={store} />
        <ControlsPanel store={store} {...(controls ? { controls } : {})} />
        <FxPanel store={store} />
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
          {/* Face div is static — visual-runtime.ts manages all attributes imperatively */}
          <StableFaceContainer id="visual-face" className="visual-face mini-visual-face" />
        </div>
        <div
          className={`mini-reaction ${state.currentReactionEmoji ? 'is-visible' : ''}`}
          aria-hidden={!state.currentReactionEmoji}
        >
          {state.currentReactionEmoji}
        </div>
        <div
          id="visual-live-transcript"
          className={`visual-live-transcript ${state.liveTranscriptText ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
        >
          {state.liveTranscriptText}
        </div>
        <div
          id="visual-subtitle"
          className={`visual-subtitle ${state.config?.secondarySubtitleEnabled === false ? 'is-hidden' : ''}`}
        />
      </section>
    </main>
  );
}

function SpectatorAppShell({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    currentExpression: current.currentExpression,
    sleeping: current.sleeping,
    connected: current.connected,
    config: current.config,
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
        <div
          id="visual-face"
          className="visual-face mini-visual-face"
          data-expression={state.currentExpression}
          data-render-mode="glitch"
        />
        <div
          id="visual-subtitle"
          className="visual-subtitle spectator-subtitle"
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

  return (
    <>
      <div className="visual-overlay visual-overlay-top-left">
        <div id="visual-donation-card" className={`visual-donation-card ${state.currentDonationSignal ? 'is-visible' : ''}`}>
          <img id="visual-donation-qr" alt="Donation QR" />
          <div className="visual-donation-copy">
            <strong id="visual-donation-handle">Venmo @TubsBot</strong>
            <span id="visual-donation-amount">{formatDonationFromSignal(state.currentDonationSignal)}</span>
          </div>
        </div>
      </div>

      <div className="visual-overlay visual-overlay-bottom">
        <div id="visual-subtitle" className={`visual-subtitle ${state.sleeping ? 'is-hidden' : ''}`} />
        <div
          id="visual-live-transcript"
          className={`visual-live-transcript ${state.liveTranscriptText ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
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
        {/* Face div is completely isolated — no re-renders from overlay state changes */}
        <StableFaceContainer id="visual-face" className={faceClassName} />
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

function FxPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.fx),
    fxEditorOpen: current.fxEditorOpen,
    fxExpressionSelected: current.fxExpressionSelected,
    fxBaseColorDraft: current.fxBaseColorDraft,
    config: current.config,
  }));
  const config = state.config;
  const faceRenderMode = config?.faceRenderMode ?? 'glitch';
  const renderQuality = config?.renderQuality ?? 'high';
  const glitchRenderer = config?.glitchRenderer ?? 'auto';
  const glitchBaseColor = config?.glitchFxBaseColor ?? state.fxBaseColorDraft;
  const glitchGlowStrength = config?.glitchGlowStrength ?? 14;
  const glitchFlickerDepth = config?.glitchFlickerDepth ?? 0.02;
  const glitchScanlineIntensity = config?.glitchScanlineIntensity ?? 0.41;
  const selectedProfile = config?.glitchExpressionProfiles?.[state.fxExpressionSelected as ExpressionName] ?? null;
  const profileEyeH = selectedProfile?.eyeH ?? 1;
  const profileEyeW = selectedProfile?.eyeW ?? 1;
  const profileEyeDy = selectedProfile?.eyeDy ?? 0;
  const profileEyeSkew = selectedProfile?.eyeSkew ?? 0;
  const profileMouthW = selectedProfile?.mouthW ?? 1;
  const profileMouthH = selectedProfile?.mouthH ?? 1;
  const profileMouthRound = selectedProfile?.mouthRound ?? false;
  const profileTears = selectedProfile?.tears ?? false;
  const profileEyeShape = selectedProfile?.eyeShape ?? 'rect';
  const profileMouthShape = selectedProfile?.mouthShape ?? 'rect';
  const profileColorHex = selectedProfile?.colorHex ?? '#a855f7';
  const profileTearColorHex = selectedProfile?.tearColorHex ?? '#57bfff';
  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="fx" title="FX" meta={config?.glitchFxEnabled ? 'glitch on' : 'glitch off'} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <div className="face-actions">
          <div className="face-action-row">
            <button
              id="fx-toggle"
              className={`button ${config?.glitchFxEnabled ? 'is-active' : 'button-secondary'}`}
              type="button"
              onClick={async () => patchFxConfig(store, { glitchFxEnabled: !store.getState().config?.glitchFxEnabled })}
            >
              {config?.glitchFxEnabled ? 'Glitch ON' : 'Glitch OFF'}
            </button>
            <button
              id="fx-editor-open"
              className={`button ${state.fxEditorOpen ? 'is-active' : 'button-secondary'}`}
              type="button"
              onClick={() => store.setState((current) => ({
                ...current,
                fxEditorOpen: !current.fxEditorOpen,
                ...(current.fxEditorOpen ? { currentExpression: current.sleeping ? 'sleep' : 'idle' } : { currentExpression: current.fxExpressionSelected }),
              }))}
            >
              {state.fxEditorOpen ? 'Close Editor' : 'Open Editor'}
            </button>
          </div>
        </div>
      </div>

      <div className={`fx-fullscreen-hud ${state.fxEditorOpen ? 'is-open' : ''}`}>
        <div className={`fx-editor-overlay ${state.fxEditorOpen ? 'is-open' : ''}`}>
          <div className="fx-editor-group">
            <div className="fx-editor-header">
              <h3>Render Settings</h3>
            </div>
            <div className="face-action-row">
              <label className="manual-field">
                <span>Mode</span>
                <select className="mini-select" value={faceRenderMode} onChange={async (e) => patchFxConfig(store, { faceRenderMode: e.currentTarget.value as any })}>
                  <option value="glitch">Glitch</option>
                  <option value="css">CSS</option>
                </select>
              </label>
              <label className="manual-field">
                <span>Quality</span>
                <select className="mini-select" value={renderQuality} onChange={async (e) => patchFxConfig(store, { renderQuality: e.currentTarget.value as any })}>
                  <option value="high">High</option>
                  <option value="balanced">Balanced</option>
                  <option value="low">Low</option>
                </select>
              </label>
              <label className="manual-field">
                <span>Renderer</span>
                <select className="mini-select" value={glitchRenderer} onChange={async (e) => patchFxConfig(store, { glitchRenderer: e.currentTarget.value as any })}>
                  <option value="auto">Auto</option>
                  <option value="webgpu">WebGPU</option>
                  <option value="canvas2d">Canvas2D</option>
                </select>
              </label>
            </div>
            <div className="face-action-row">
              <label className="manual-field">
                <span>Preset</span>
                <select className="mini-select" defaultValue="" onChange={async (e) => {
                  const selected = GLITCH_PRESETS[e.currentTarget.value];
                  if (selected) await patchFxConfig(store, selected);
                  e.currentTarget.value = '';
                }}>
                  <option value="">Select preset</option>
                  <option value="default">Default</option>
                  <option value="cyberpunk">Cyberpunk</option>
                  <option value="minimal">Minimal</option>
                  <option value="warm">Warm</option>
                </select>
              </label>
              <label className="manual-field">
                <span>Color</span>
                <input className="fx-color-input" type="color" value={state.fxBaseColorDraft} onChange={(e) => store.setState(c => ({ ...c, fxBaseColorDraft: normalizeHex(e.currentTarget.value, c.fxBaseColorDraft) }))} />
              </label>
              <button className="button button-secondary" type="button" onClick={async () => patchFxConfig(store, { glitchFxBaseColor: store.getState().fxBaseColorDraft })}>Apply</button>
            </div>
          </div>

          <div className="fx-editor-group">
            <div className="fx-editor-header">
              <h3>Expression Profiles</h3>
              <div className="face-action-row">
                <button className="button button-secondary" type="button" onClick={() => exportGlitchConfig(store.getState().config)}>Export</button>
                <button className="button button-secondary" type="button" onClick={() => importGlitchConfig(store)}>Import</button>
                <button className="button button-secondary" type="button" onClick={async () => patchFxConfig(store, GLITCH_PRESETS.default ?? {})}>Reset</button>
              </div>
            </div>
            <div className="face-action-row">
              <label className="manual-field">
                <span>Expression</span>
                <select className="mini-select" value={state.fxExpressionSelected} onChange={(e) => {
                  const next = normalizeExpressionName(e.currentTarget.value);
                  store.setState(c => ({
                    ...c,
                    fxExpressionSelected: next,
                    ...(c.fxEditorOpen ? { currentExpression: next } : {}),
                  }));
                }}>
                  <option value="idle">idle</option>
                  <option value="idle-flat">idle-flat</option>
                  <option value="listening">listening</option>
                  <option value="thinking">thinking</option>
                  <option value="speaking">speaking</option>
                  <option value="smile">smile</option>
                  <option value="happy">happy</option>
                  <option value="love">love</option>
                  <option value="sad">sad</option>
                  <option value="crying">crying</option>
                  <option value="sleep">sleep</option>
                  <option value="angry">angry</option>
                  <option value="surprised">surprised</option>
                </select>
              </label>
              <button className="button button-secondary" type="button" onClick={async () => {
                const expression = store.getState().fxExpressionSelected;
                await patchFxConfig(store, patchExpressionProfile(store.getState().config, expression, null));
                previewExpression(store, expression);
              }}>Reset Profile</button>
            </div>
            <FxRange label="Eye Height" dataKey="eyeH" value={profileEyeH} min={0.05} max={2} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeH', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <FxRange label="Eye Width" dataKey="eyeW" value={profileEyeW} min={0.3} max={2} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeW', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <FxRange label="Eye Offset Y" dataKey="eyeDy" value={profileEyeDy} min={-10} max={15} step={0.5} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeDy', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <FxRange label="Eye Skew" dataKey="eyeSkew" value={profileEyeSkew} min={-0.5} max={0.5} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeSkew', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <FxRange label="Mouth W" dataKey="mouthW" value={profileMouthW} min={0.1} max={2} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'mouthW', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <FxRange label="Mouth H" dataKey="mouthH" value={profileMouthH} min={0.1} max={4} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'mouthH', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <FxToggle label="Mouth Round" dataKey="mouthRound" checked={profileMouthRound} onChange={(checked) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'toggle', key: 'mouthRound', value: checked })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <FxToggle label="Tears" dataKey="tears" checked={profileTears} onChange={(checked) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'toggle', key: 'tears', value: checked })); previewExpression(store, store.getState().fxExpressionSelected); }} />
            <label className="manual-field">
              <span>Eye Shape</span>
              <select className="mini-select" value={profileEyeShape} onChange={(e) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'select', key: 'eyeShape', value: e.currentTarget.value })); previewExpression(store, store.getState().fxExpressionSelected); }}>
                <option value="rect">rect</option>
                <option value="heart">heart</option>
              </select>
            </label>
            <label className="manual-field">
              <span>Mouth Shape</span>
              <select className="mini-select" value={profileMouthShape} onChange={(e) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'select', key: 'mouthShape', value: e.currentTarget.value })); previewExpression(store, store.getState().fxExpressionSelected); }}>
                <option value="rect">rect</option>
                <option value="frown">frown</option>
                <option value="smile-arc">smile-arc</option>
                <option value="round">round</option>
              </select>
            </label>
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

function FxRange(props: {
  label: string;
  dataKey: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (value: number) => void;
}): JSX.Element {
  return (
    <label className="fx-slider-row">
      <span>{props.label}</span>
      <input
        data-fx-expression-range={props.dataKey}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => {
          props.onInput(Number(event.currentTarget.value));
        }}
      />
      <strong>{props.value.toFixed(props.step >= 1 ? 0 : props.step >= 0.1 ? 1 : 3)}</strong>
    </label>
  );
}

function FxToggle(props: {
  label: string;
  dataKey: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="voice-toggle fx-toggle-row">
      <input
        data-fx-expression-toggle={props.dataKey}
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onChange(event.currentTarget.checked);
        }}
      />
      <span>{props.label}</span>
    </label>
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

function formatDonationFromSignal(signal: AppState['currentDonationSignal']): string {
  if (!signal) {
    return 'No signal';
  }
  const amount = signal.amount ? `${signal.amount}${signal.currency ? ` ${signal.currency}` : ''}` : null;
  return [signal.certainty, signal.source, amount, signal.donor].filter(Boolean).join(' · ');
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

function renderFxMarkup(args: {
  fxEditorOpen: boolean;
  fxExpressionSelected: string;
  fxBaseColorDraft: `#${string}`;
  config: AppState['config'];
}): string {
  const config = args.config;
  const faceRenderMode = config?.faceRenderMode ?? 'glitch';
  const renderQuality = config?.renderQuality ?? 'high';
  const glitchRenderer = config?.glitchRenderer ?? 'auto';
  const glitchBaseColor = config?.glitchFxBaseColor ?? args.fxBaseColorDraft;
  const glitchGlowStrength = config?.glitchGlowStrength ?? 14;
  const glitchFlickerDepth = config?.glitchFlickerDepth ?? 0.02;
  const glitchScanlineIntensity = config?.glitchScanlineIntensity ?? 0.41;
  const selectedExpression = args.fxExpressionSelected;
  const selectedProfile = config?.glitchExpressionProfiles?.[selectedExpression as ExpressionName] ?? null;
  const profileEyeH = selectedProfile?.eyeH ?? 1;
  const profileEyeW = selectedProfile?.eyeW ?? 1;
  const profileEyeDy = selectedProfile?.eyeDy ?? 0;
  const profileEyeSkew = selectedProfile?.eyeSkew ?? 0;
  const profileMouthW = selectedProfile?.mouthW ?? 1;
  const profileMouthH = selectedProfile?.mouthH ?? 1;
  const profileMouthRound = selectedProfile?.mouthRound ?? false;
  const profileTears = selectedProfile?.tears ?? false;
  const profileEyeShape = selectedProfile?.eyeShape ?? 'rect';
  const profileMouthShape = selectedProfile?.mouthShape ?? 'rect';
  const profileColorHex = selectedProfile?.colorHex ?? '#a855f7';
  const profileTearColorHex = selectedProfile?.tearColorHex ?? '#57bfff';

  return `
        <dl class="kv">
          <div><dt>Render Mode</dt><dd>${escapeHtml(faceRenderMode)}</dd></div>
          <div><dt>Renderer</dt><dd>${escapeHtml(glitchRenderer)}</dd></div>
          <div><dt>Quality</dt><dd>${escapeHtml(renderQuality)}</dd></div>
          <div><dt>Base Color</dt><dd>${escapeHtml(glitchBaseColor)}</dd></div>
          <div><dt>Glow</dt><dd>${glitchGlowStrength.toFixed(0)} px</dd></div>
          <div><dt>Flicker</dt><dd>${glitchFlickerDepth.toFixed(3)}</dd></div>
          <div><dt>Scanline</dt><dd>${glitchScanlineIntensity.toFixed(2)}</dd></div>
        </dl>
        <div class="face-actions">
          <div class="face-action-row">
            <button id="fx-toggle" class="button button-secondary" type="button">${config?.glitchFxEnabled ? 'Disable Glitch' : 'Enable Glitch'}</button>
            <button id="fx-editor-open" class="button button-secondary" type="button">${args.fxEditorOpen ? 'Editor Open' : 'Open Editor'}</button>
          </div>
          <div class="face-action-row">
            <label class="manual-field">
              <span>Render Mode</span>
              <select id="face-render-mode-select" class="mini-select">
                <option value="glitch" ${faceRenderMode === 'glitch' ? 'selected' : ''}>Glitch</option>
                <option value="svg" ${faceRenderMode === 'svg' ? 'selected' : ''}>SVG</option>
                <option value="css" ${faceRenderMode === 'css' ? 'selected' : ''}>CSS</option>
              </select>
            </label>
            <label class="manual-field">
              <span>Render Quality</span>
              <select id="face-render-quality-select" class="mini-select">
                <option value="high" ${renderQuality === 'high' ? 'selected' : ''}>High</option>
                <option value="balanced" ${renderQuality === 'balanced' ? 'selected' : ''}>Balanced</option>
                <option value="low" ${renderQuality === 'low' ? 'selected' : ''}>Low</option>
              </select>
            </label>
          </div>
          <div class="face-action-row">
            <label class="manual-field">
              <span>Renderer</span>
              <select id="glitch-renderer-select" class="mini-select">
                <option value="auto" ${glitchRenderer === 'auto' ? 'selected' : ''}>Auto</option>
                <option value="webgpu" ${glitchRenderer === 'webgpu' ? 'selected' : ''}>WebGPU</option>
                <option value="canvas2d" ${glitchRenderer === 'canvas2d' ? 'selected' : ''}>Canvas2D</option>
              </select>
            </label>
            <label class="manual-field">
              <span>Preset</span>
              <select id="glitch-preset-select" class="mini-select">
                <option value="">Select preset</option>
                <option value="default">Default</option>
                <option value="cyberpunk">Cyberpunk</option>
                <option value="minimal">Minimal</option>
                <option value="warm">Warm</option>
              </select>
            </label>
          </div>
          <div class="face-action-row">
            <input id="fx-base-color" class="fx-color-input" type="color" value="${escapeAttribute(args.fxBaseColorDraft)}" />
            <button id="fx-color-apply" class="button button-secondary" type="button">Apply Color</button>
          </div>
          <div class="fx-editor-shell ${args.fxEditorOpen ? 'is-open' : ''}">
            <div class="fx-editor-header">
              <strong>FX Editor</strong>
              <div class="face-action-row">
                <button id="glitch-export-button" class="button button-secondary" type="button">Export</button>
                <button id="glitch-import-button" class="button button-secondary" type="button">Import</button>
                <button id="glitch-reset-button" class="button button-secondary" type="button">Reset</button>
                <button id="fx-editor-close" class="button button-secondary" type="button">Close</button>
              </div>
            </div>
            <div class="fx-editor-group">
              <h3>Expression Profiles</h3>
              <div class="face-action-row">
                <label class="manual-field">
                  <span>Expression</span>
                  <select id="fx-expression-select" class="mini-select">
                    ${renderExpressionOption('idle', selectedExpression)}
                    ${renderExpressionOption('idle-flat', selectedExpression)}
                    ${renderExpressionOption('listening', selectedExpression)}
                    ${renderExpressionOption('thinking', selectedExpression)}
                    ${renderExpressionOption('speaking', selectedExpression)}
                    ${renderExpressionOption('smile', selectedExpression)}
                    ${renderExpressionOption('happy', selectedExpression)}
                    ${renderExpressionOption('love', selectedExpression)}
                    ${renderExpressionOption('sad', selectedExpression)}
                    ${renderExpressionOption('crying', selectedExpression)}
                    ${renderExpressionOption('sleep', selectedExpression)}
                    ${renderExpressionOption('angry', selectedExpression)}
                    ${renderExpressionOption('surprised', selectedExpression)}
                  </select>
                </label>
                <button id="fx-expression-reset" class="button button-secondary" type="button">Reset Profile</button>
              </div>
              ${renderFxSlider('Eye Height', 'eyeH', profileEyeH, 0.05, 2, 0.01, 'expression-range')}
              ${renderFxSlider('Eye Width', 'eyeW', profileEyeW, 0.3, 2, 0.01, 'expression-range')}
              ${renderFxSlider('Eye Offset Y', 'eyeDy', profileEyeDy, -10, 15, 0.5, 'expression-range')}
              ${renderFxSlider('Eye Skew', 'eyeSkew', profileEyeSkew, -0.5, 0.5, 0.01, 'expression-range')}
              ${renderFxSlider('Mouth Width', 'mouthW', profileMouthW, 0.1, 2, 0.01, 'expression-range')}
              ${renderFxSlider('Mouth Height', 'mouthH', profileMouthH, 0.1, 4, 0.01, 'expression-range')}
              ${renderFxToggle('Mouth Round', 'mouthRound', profileMouthRound, 'expression-toggle')}
              ${renderFxToggle('Tears', 'tears', profileTears, 'expression-toggle')}
              ${renderFxSelect('Eye Shape', 'eyeShape', profileEyeShape, ['rect', 'heart'])}
              ${renderFxSelect('Mouth Shape', 'mouthShape', profileMouthShape, ['rect', 'frown', 'smile-arc', 'round'])}
              ${renderFxColor('Color Override', 'colorHex', profileColorHex)}
              ${renderFxColor('Tear Color', 'tearColorHex', profileTearColorHex)}
            </div>
          </div>
        </div>
        `;
}

function renderFxSlider(
  label: string,
  key: string,
  value: number,
  min: number,
  max: number,
  step: number,
  datasetType: 'config-range' | 'expression-range' = 'config-range',
): string {
  const datasetAttribute = datasetType === 'expression-range' ? 'data-fx-expression-range' : 'data-fx-config-range';
  return `
        <label class="fx-slider-row">
          <span>${escapeHtml(label)}</span>
          <input ${datasetAttribute}="${escapeAttribute(key)}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />
          <strong>${value.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 3)}</strong>
        </label>
        `;
}

function renderFxToggle(label: string, key: string, checked: boolean, datasetType: 'config-toggle' | 'expression-toggle' = 'config-toggle'): string {
  const datasetAttribute = datasetType === 'expression-toggle' ? 'data-fx-expression-toggle' : 'data-fx-config-toggle';
  return `
        <label class="voice-toggle fx-toggle-row">
          <input ${datasetAttribute}="${escapeAttribute(key)}" type="checkbox" ${checked ? 'checked' : ''} />
          <span>${escapeHtml(label)}</span>
        </label>
        `;
}

function renderFxSelect(label: string, key: string, value: string, options: string[]): string {
  return `
        <label class="manual-field">
          <span>${escapeHtml(label)}</span>
          <select data-fx-expression-select="${escapeAttribute(key)}" class="mini-select">
            ${options.map((option) => `<option value="${escapeAttribute(option)}" ${value === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>
        </label>
        `;
}

function renderFxColor(label: string, key: string, value: `#${string}`): string {
  return `
        <label class="manual-field">
          <span>${escapeHtml(label)}</span>
          <input data-fx-expression-color="${escapeAttribute(key)}" class="fx-color-input" type="color" value="${escapeAttribute(value)}" />
        </label>
        `;
}

function renderExpressionOption(name: string, selected: string): string {
  return `<option value="${escapeAttribute(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
