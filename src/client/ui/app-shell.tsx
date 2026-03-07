import { useRef, type JSX } from 'react';
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
import { renderFaceVisualMarkup } from './face-visual.js';
import { useAppSelector } from './react-store.js';

export interface AppShellProps {
  mode: 'main' | 'mini';
  store: AppStore;
}

export function AppShell(props: AppShellProps): JSX.Element {
  return props.mode === 'mini'
    ? <MiniAppShell store={props.store} />
    : <MainAppShell store={props.store} />;
}

function MainAppShell({ store }: { store: AppStore }): JSX.Element {
  const shellState = useAppSelector(store, (state) => ({
    uiHidden: state.uiHidden,
    fullscreenActive: state.fullscreenActive,
  }));

  return (
    <main className={`shell ${shellState.uiHidden ? 'shell-ui-hidden' : ''} ${shellState.fullscreenActive ? 'fullscreen-active' : ''}`}>
      <HeroSection store={store} />
      <section className="visual-workspace">
        <VoicePanel store={store} />
        <VisualShell store={store} mode="main" />
        <FacePanel store={store} />
      </section>
      <section className="grid">
        <ConnectionPanel store={store} />
        <HealthPanel store={store} />
        <ConfigPanel store={store} />
        <StatsPanel store={store} />
        <AssistantPanel store={store} />
        <ControlsPanel store={store} />
        <FxPanel store={store} />
        <ManualPanel store={store} />
      </section>
      <ChatPanel store={store} />
      <section className="grid">
        <StreamDebugPanel store={store} />
        <EventLogPanel store={store} />
      </section>
    </main>
  );
}

function MiniAppShell({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    connected: current.connected,
    lastMessageType: current.lastMessageType,
    currentExpression: current.currentExpression,
    sleeping: current.sleeping,
    audioPlaying: current.audioPlaying,
    liveTranscriptText: current.liveTranscriptText,
    liveTranscriptDraft: current.liveTranscriptDraft,
    subtitleText: current.subtitleText,
    currentSpeechText: current.currentSpeechText,
    config: current.config,
    health: current.health,
  }));
  const initialFaceMarkup = useRef(renderFaceVisualMarkup(store.getState())).current;

  return (
    <main className="mini-shell">
      <section className={`visual-shell mini-visual-shell ${state.sleeping ? 'is-sleeping' : ''}`}>
        <div
          id="visual-face"
          className="visual-face mini-visual-face"
          data-expression={state.currentExpression}
          data-render-mode={state.config?.faceRenderMode ?? 'css'}
          dangerouslySetInnerHTML={{ __html: initialFaceMarkup }}
        />
        <div
          id="visual-live-transcript"
          className={`visual-live-transcript ${state.liveTranscriptText ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
        >
          {state.liveTranscriptText}
        </div>
        <div id="visual-subtitle" className="visual-subtitle">
          {state.subtitleText || state.currentSpeechText || ''}
        </div>
      </section>
      <p className="eyebrow">Mini</p>
      <h1>{state.connected ? 'Connected' : 'Waiting'}</h1>
      <p className="mini-copy">
        {state.connected ? `Last message: ${state.lastMessageType}` : 'Waiting for the TypeScript bridge server.'}
      </p>
      <dl className="mini-kv">
        <div><dt>Render</dt><dd>{state.config?.faceRenderMode ?? 'n/a'}</dd></div>
        <div><dt>Mode</dt><dd>{state.health?.processingMode ?? 'n/a'}</dd></div>
        <div><dt>Model</dt><dd>{state.config?.llmModel ?? 'n/a'}</dd></div>
        <div><dt>Expression</dt><dd>{state.currentExpression}</dd></div>
        <div><dt>Sleep</dt><dd>{state.sleeping ? 'yes' : 'no'}</dd></div>
        <div><dt>Audio</dt><dd>{state.audioPlaying ? 'speaking' : 'idle'}</dd></div>
      </dl>
    </main>
  );
}

function HeroSection({ store }: { store: AppStore }): JSX.Element {
  const fullscreenActive = useAppSelector(store, (state) => state.fullscreenActive);
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">Tubs Face</p>
        <h1>TypeScript Client Shell</h1>
        <p className="lede">
          Main app entry is now running from <code>src/client/</code> against the TypeScript server core.
        </p>
      </div>
      <div className="hero-actions">
        <button id="window-open-mini" className="button button-secondary" type="button">Open Mini Window</button>
        <button id="window-fullscreen" className="button" type="button">{fullscreenActive ? 'Exit Fullscreen' : 'Fullscreen'}</button>
      </div>
    </section>
  );
}

function VoicePanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.voice),
    micReady: current.micReady,
    micDenied: current.micDenied,
    micLevel: current.micLevel,
    recording: current.recording,
    listenState: current.listenState,
    voiceWakeWordEnabled: current.voiceWakeWordEnabled,
    voiceHandsFreeEnabled: current.voiceHandsFreeEnabled,
    audioPlaying: current.audioPlaying,
    voiceLastTranscript: current.voiceLastTranscript,
  }));

  const pending = !state.recording && (state.listenState === 'Uploading...' || state.listenState === 'Thinking...');

  return (
    <article className={`${renderPanelCardClass(state.collapsed)} voice-panel-card`}>
      <PanelHeader store={store} panelKey="voice" title="Voice" meta={state.listenState} metaId="voice-panel-meta" />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <dl className="kv">
          <div><dt>Mic</dt><dd id="voice-mic-value">{state.micReady ? 'ready' : state.micDenied ? 'denied' : 'pending'}</dd></div>
          <div><dt>State</dt><dd id="voice-state-value">{state.listenState}</dd></div>
          <div><dt>Wake Word</dt><dd id="voice-wakeword-value">{state.voiceWakeWordEnabled ? 'on' : 'off'}</dd></div>
          <div><dt>Mode</dt><dd id="voice-mode-value">{state.voiceHandsFreeEnabled ? 'hands-free' : 'push-to-talk'}</dd></div>
          <div><dt>Playback</dt><dd id="voice-playback-value">{state.audioPlaying ? 'speaking' : 'idle'}</dd></div>
        </dl>
        <div className="voice-meter">
          <span id="voice-meter-bar" className="voice-meter-bar" style={{ transform: `scaleX(${Math.max(0.05, state.micLevel).toFixed(3)})` }} />
        </div>
        <div className="face-actions">
          <div className="face-action-row">
            <button id="voice-enable-mic" className="button button-secondary" type="button">Enable Mic</button>
            <button id="voice-record-button" className={`button ${state.recording ? 'button-live' : pending ? 'is-pending' : ''}`} type="button">
              {state.recording ? 'Recording… release to send' : pending ? state.listenState : 'Push to Talk'}
            </button>
          </div>
          <label className="voice-toggle">
            <input
              id="voice-handsfree-toggle"
              type="checkbox"
              checked={state.voiceHandsFreeEnabled}
              onChange={(event) => {
                store.setState((current) => ({
                  ...current,
                  voiceHandsFreeEnabled: event.currentTarget.checked,
                  listenState: current.recording
                    ? current.listenState
                    : event.currentTarget.checked
                      ? 'Hands-free ready'
                      : (current.micReady ? 'Mic ready' : current.listenState),
                }));
              }}
            />
            <span>Always listen</span>
          </label>
          <label className="voice-toggle">
            <input
              id="voice-wakeword-toggle"
              type="checkbox"
              checked={state.voiceWakeWordEnabled}
              onChange={(event) => {
                store.setState((current) => ({
                  ...current,
                  voiceWakeWordEnabled: event.currentTarget.checked,
                }));
              }}
            />
            <span>Require wake word</span>
          </label>
          <p id="voice-last-transcript" className="voice-copy">
            {state.voiceLastTranscript || 'Speak naturally or use push-to-talk to send a voice turn.'}
          </p>
        </div>
      </div>
    </article>
  );
}

function VisualShell({ store, mode }: { store: AppStore; mode: 'main' | 'mini' }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    sleeping: current.sleeping,
    currentExpression: current.currentExpression,
    liveTranscriptText: current.liveTranscriptText,
    liveTranscriptDraft: current.liveTranscriptDraft,
    subtitleText: current.subtitleText,
    currentSpeechText: current.currentSpeechText,
    currentDonationSignal: current.currentDonationSignal,
    config: current.config,
  }));
  const initialFaceMarkup = useRef(renderFaceVisualMarkup(store.getState())).current;

  return (
    <section className={`visual-shell ${state.sleeping ? 'is-sleeping' : ''}`}>
      <div
        id="visual-face"
        className="visual-face"
        data-expression={state.currentExpression}
        data-render-mode={state.config?.faceRenderMode ?? 'glitch'}
        dangerouslySetInnerHTML={{ __html: initialFaceMarkup }}
      />
      <div id="visual-subtitle" className={`visual-subtitle ${state.sleeping ? 'is-hidden' : ''}`}>
        {state.subtitleText || state.currentSpeechText || ''}
      </div>
      <div
        id="visual-live-transcript"
        className={`visual-live-transcript ${state.liveTranscriptText ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
      >
        {state.liveTranscriptText}
      </div>
      <div id="visual-donation-card" className={`visual-donation-card ${state.currentDonationSignal ? 'is-visible' : ''}`}>
        <img id="visual-donation-qr" alt="Donation QR" />
        <div className="visual-donation-copy">
          <strong id="visual-donation-handle">{mode === 'mini' ? 'Venmo @TubsBot' : 'Venmo @TubsBot'}</strong>
          <span id="visual-donation-amount">{formatDonationFromSignal(state.currentDonationSignal)}</span>
        </div>
      </div>
    </section>
  );
}

function FacePanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.face),
    faceWorkerReady: current.faceWorkerReady,
    faceWorkerBusy: current.faceWorkerBusy,
    faceCameraActive: current.faceCameraActive,
    faceStatus: current.faceStatus,
    faceLastDetectedCount: current.faceLastDetectedCount,
    faceLastInferenceMs: current.faceLastInferenceMs,
    faceLastEmbeddingsExtracted: current.faceLastEmbeddingsExtracted,
    faceLastEmbeddingsReused: current.faceLastEmbeddingsReused,
    faceLibraryEmbeddings: current.faceLibraryEmbeddings,
    faceLibraryPeople: current.faceLibraryPeople,
    faceDraftName: current.faceDraftName,
    faceLastFaces: current.faceLastFaces,
  }));

  return (
    <article id="face-panel-card" className={`${renderPanelCardClass(state.collapsed)} face-panel-card`}>
      <PanelHeader store={store} panelKey="face" title="Face Worker" meta={formatFaceSummary(state)} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <p id="face-summary-metric" className={`metric ${state.faceWorkerReady ? 'is-good' : 'is-bad'}`}>{formatFaceSummary(state)}</p>
        <div className="camera-shell">
          <div className="camera-stage">
            <video id="face-camera-video" className={`camera-video ${state.faceCameraActive ? '' : 'is-hidden'}`} autoPlay muted playsInline />
            <canvas id="face-camera-overlay" className={`camera-overlay ${state.faceCameraActive ? '' : 'is-hidden'}`} />
            <div className={`camera-placeholder ${state.faceCameraActive ? 'is-hidden' : ''}`}>Camera inactive</div>
          </div>
        </div>
        <div className="face-panel-secondary">
          <dl className="kv">
            <div><dt>Status</dt><dd id="face-status-value">{state.faceStatus}</dd></div>
            <div><dt>Inference</dt><dd id="face-inference-value">{state.faceLastInferenceMs == null ? 'n/a' : `${state.faceLastInferenceMs} ms`}</dd></div>
            <div><dt>Embeddings</dt><dd id="face-embeddings-value">{state.faceLastEmbeddingsExtracted} new / {state.faceLastEmbeddingsReused} cached</dd></div>
            <div><dt>Library</dt><dd id="face-library-value">{state.faceLibraryEmbeddings} embeddings / {state.faceLibraryPeople} people</dd></div>
          </dl>
          <div className="face-actions">
            <input id="face-upload-input" className="sr-only" type="file" accept="image/png,image/jpeg,image/jpg" />
            <div className="face-action-row">
              <button id="face-camera-toggle" className="button" type="button">
                {state.faceCameraActive ? 'Stop Camera' : 'Start Camera'}
              </button>
              <button id="face-upload-trigger" className="button" type="button" disabled={state.faceWorkerBusy}>
                {state.faceWorkerBusy ? 'Processing…' : 'Detect From Image'}
              </button>
              <button id="face-refresh-trigger" className="button button-secondary" type="button">
                Refresh Library
              </button>
            </div>
            <div className="face-action-row">
              <input
                id="face-enroll-name"
                className="face-name-input"
                type="text"
                placeholder="Name this face"
                value={state.faceDraftName}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store.setState((current) => ({
                    ...current,
                    faceDraftName: value,
                  }));
                }}
              />
              <button id="face-save-trigger" className="button" type="button" disabled={!state.faceLastFaces.some((face) => Array.isArray(face.embedding))}>
                Save First Face
              </button>
            </div>
          </div>
          <ul id="face-results-list" className="face-list">
            {state.faceLastFaces.length === 0
              ? <li className="face-item face-item-empty">No detections yet.</li>
              : state.faceLastFaces.map((face, index) => (
                <li key={`${face.name ?? face.match?.name ?? 'face'}-${index}`} className="face-item">
                  <div className="face-item-copy">
                    <strong>{face.name ?? face.match?.name ?? `Face ${index + 1}`}</strong>
                    <span>{renderFaceMeta(face)}</span>
                  </div>
                  <span>{Math.round((face.match?.score ?? face.confidence ?? face.score) * 100)}%</span>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

function ConnectionPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.connection),
    connectionLabel: current.connectionLabel,
    connected: current.connected,
    serverUrl: current.serverUrl,
    lastMessageType: current.lastMessageType,
    lastPingMs: current.lastPingMs,
  }));

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="connection" title="Connection" meta={state.connectionLabel} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <p className={`metric ${state.connected ? 'is-good' : 'is-bad'}`}>{state.connectionLabel}</p>
        <dl className="kv">
          <div><dt>Server</dt><dd>{state.serverUrl}</dd></div>
          <div><dt>Last WS</dt><dd>{state.lastMessageType}</dd></div>
          <div><dt>Ping</dt><dd>{state.lastPingMs == null ? 'n/a' : `${state.lastPingMs} ms`}</dd></div>
        </dl>
      </div>
    </article>
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

function StatsPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.stats),
    stats: current.stats,
    config: current.config,
  }));

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="stats" title="Stats" meta={`${state.stats?.tokensOut ?? 0} out`} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <dl className="kv">
          <div><dt>Tokens In</dt><dd>{state.stats?.tokensIn ?? 0}</dd></div>
          <div><dt>Tokens Out</dt><dd>{state.stats?.tokensOut ?? 0}</dd></div>
          <div><dt>Cost</dt><dd>{formatCurrency(state.stats?.costUsd)}</dd></div>
          <div><dt>Model</dt><dd>{state.stats?.model ?? state.config?.model ?? 'n/a'}</dd></div>
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
    currentIncomingText: current.currentIncomingText,
    currentSpeechText: current.currentSpeechText,
    currentDonationSignal: current.currentDonationSignal,
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
        <div className="assistant-copy">
          <p><strong>User</strong> <span id="assistant-user-copy">{state.currentIncomingText || 'No incoming text yet.'}</span></p>
          <p><strong>Tubs</strong> <span id="assistant-speech-copy">{state.currentSpeechText || 'No spoken output yet.'}</span></p>
          <p><strong>Donation</strong> <span id="assistant-donation-copy">{formatDonationFromSignal(state.currentDonationSignal)}</span></p>
        </div>
      </div>
    </article>
  );
}

function ControlsPanel({ store }: { store: AppStore }): JSX.Element {
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
              className="button button-secondary"
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
            <button id="ambient-toggle" className="button button-secondary" type="button">Ambient {state.ambientAudioEnabled ? 'On' : 'Off'}</button>
          </div>
          <div className="face-action-row">
            <button
              id="action-wake"
              className="button button-secondary"
              type="button"
              onClick={async () => {
                await runControlAction(store, 'Wake', () => postJson<undefined, OkResponse>('/wake'));
              }}
            >
              {state.sleeping ? 'Wake' : 'Awake'}
            </button>
            <button
              id="action-sleep"
              className="button button-secondary"
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
              className="button"
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
          </div>
          <div className="face-action-row">
            <input
              id="action-donation-amount"
              className="face-name-input"
              type="text"
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
              className="button"
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
        <dl className="kv">
          <div><dt>Render Mode</dt><dd>{faceRenderMode}</dd></div>
          <div><dt>Renderer</dt><dd>{glitchRenderer}</dd></div>
          <div><dt>Quality</dt><dd>{renderQuality}</dd></div>
          <div><dt>Base Color</dt><dd>{glitchBaseColor}</dd></div>
          <div><dt>Glow</dt><dd>{glitchGlowStrength.toFixed(0)} px</dd></div>
          <div><dt>Flicker</dt><dd>{glitchFlickerDepth.toFixed(3)}</dd></div>
          <div><dt>Scanline</dt><dd>{glitchScanlineIntensity.toFixed(2)}</dd></div>
        </dl>
        <div className="face-actions">
          <div className="face-action-row">
            <button
              id="fx-toggle"
              className="button button-secondary"
              type="button"
              onClick={async () => {
                await patchFxConfig(store, { glitchFxEnabled: !store.getState().config?.glitchFxEnabled });
              }}
            >
              {config?.glitchFxEnabled ? 'Disable Glitch' : 'Enable Glitch'}
            </button>
            <button
              id="fx-editor-open"
              className="button button-secondary"
              type="button"
              onClick={() => {
                store.setState((current) => ({
                  ...current,
                  fxEditorOpen: true,
                  currentExpression: current.fxExpressionSelected,
                }));
              }}
            >
              {state.fxEditorOpen ? 'Editor Open' : 'Open Editor'}
            </button>
          </div>
          <div className="face-action-row">
            <label className="manual-field">
              <span>Render Mode</span>
              <select
                id="face-render-mode-select"
                className="mini-select"
                value={faceRenderMode}
                onChange={async (event) => {
                  const value = event.currentTarget.value === 'css'
                    ? 'css'
                    : event.currentTarget.value === 'svg'
                      ? 'svg'
                      : 'glitch';
                  await patchFxConfig(store, { faceRenderMode: value });
                }}
              >
                <option value="glitch">Glitch</option>
                <option value="svg">SVG</option>
                <option value="css">CSS</option>
              </select>
            </label>
            <label className="manual-field">
              <span>Render Quality</span>
              <select
                id="face-render-quality-select"
                className="mini-select"
                value={renderQuality}
                onChange={async (event) => {
                  const value = event.currentTarget.value === 'balanced' || event.currentTarget.value === 'low'
                    ? event.currentTarget.value
                    : 'high';
                  await patchFxConfig(store, { renderQuality: value });
                }}
              >
                <option value="high">High</option>
                <option value="balanced">Balanced</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
          <div className="face-action-row">
            <label className="manual-field">
              <span>Renderer</span>
              <select
                id="glitch-renderer-select"
                className="mini-select"
                value={glitchRenderer}
                onChange={async (event) => {
                  const value = event.currentTarget.value === 'webgpu' || event.currentTarget.value === 'canvas2d'
                    ? event.currentTarget.value
                    : 'auto';
                  await patchFxConfig(store, { glitchRenderer: value });
                }}
              >
                <option value="auto">Auto</option>
                <option value="webgpu">WebGPU</option>
                <option value="canvas2d">Canvas2D</option>
              </select>
            </label>
            <label className="manual-field">
              <span>Preset</span>
              <select
                id="glitch-preset-select"
                className="mini-select"
                defaultValue=""
                onChange={async (event) => {
                  const selected = GLITCH_PRESETS[event.currentTarget.value];
                  if (!selected) {
                    return;
                  }
                  await patchFxConfig(store, selected);
                  event.currentTarget.value = '';
                }}
              >
                <option value="">Select preset</option>
                <option value="default">Default</option>
                <option value="cyberpunk">Cyberpunk</option>
                <option value="minimal">Minimal</option>
                <option value="warm">Warm</option>
              </select>
            </label>
          </div>
          <div className="face-action-row">
            <input
              id="fx-base-color"
              className="fx-color-input"
              type="color"
              value={state.fxBaseColorDraft}
              onChange={(event) => {
                const value = normalizeHex(event.currentTarget.value, state.fxBaseColorDraft);
                store.setState((current) => ({
                  ...current,
                  fxBaseColorDraft: value,
                }));
              }}
            />
            <button
              id="fx-color-apply"
              className="button button-secondary"
              type="button"
              onClick={async () => {
                await patchFxConfig(store, {
                  glitchFxBaseColor: normalizeHex(store.getState().fxBaseColorDraft, store.getState().fxBaseColorDraft),
                });
              }}
            >
              Apply Color
            </button>
          </div>
          <div className={`fx-editor-shell ${state.fxEditorOpen ? 'is-open' : ''}`}>
            <div className="fx-editor-header">
              <strong>FX Editor</strong>
              <div className="face-action-row">
                <button id="glitch-export-button" className="button button-secondary" type="button" onClick={() => exportGlitchConfig(store.getState().config)}>Export</button>
                <button id="glitch-import-button" className="button button-secondary" type="button" onClick={() => { void importGlitchConfig(store); }}>Import</button>
                <button id="glitch-reset-button" className="button button-secondary" type="button" onClick={async () => { await patchFxConfig(store, GLITCH_PRESETS.default ?? {}); }}>Reset</button>
                <button
                  id="fx-editor-close"
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    store.setState((current) => ({
                      ...current,
                      fxEditorOpen: false,
                      currentExpression: current.sleeping ? 'sleep' : 'idle',
                    }));
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="fx-editor-group">
              <h3>Expression Profiles</h3>
              <div className="face-action-row">
                <label className="manual-field">
                  <span>Expression</span>
                  <select
                    id="fx-expression-select"
                    className="mini-select"
                    value={state.fxExpressionSelected}
                    onChange={(event) => {
                      const next = normalizeExpressionName(event.currentTarget.value);
                      store.setState((current) => ({
                        ...current,
                        fxExpressionSelected: next,
                        ...(current.fxEditorOpen ? { currentExpression: next } : {}),
                      }));
                    }}
                  >
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
                <button
                  id="fx-expression-reset"
                  className="button button-secondary"
                  type="button"
                  onClick={async () => {
                    const expression = store.getState().fxExpressionSelected;
                    await patchFxConfig(store, patchExpressionProfile(store.getState().config, expression, null));
                    previewExpression(store, expression);
                  }}
                >
                  Reset Profile
                </button>
              </div>
              <FxRange label="Eye Height" dataKey="eyeH" value={profileEyeH} min={0.05} max={2} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeH', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <FxRange label="Eye Width" dataKey="eyeW" value={profileEyeW} min={0.3} max={2} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeW', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <FxRange label="Eye Offset Y" dataKey="eyeDy" value={profileEyeDy} min={-10} max={15} step={0.5} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeDy', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <FxRange label="Eye Skew" dataKey="eyeSkew" value={profileEyeSkew} min={-0.5} max={0.5} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'eyeSkew', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <FxRange label="Mouth Width" dataKey="mouthW" value={profileMouthW} min={0.1} max={2} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'mouthW', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <FxRange label="Mouth Height" dataKey="mouthH" value={profileMouthH} min={0.1} max={4} step={0.01} onInput={(value) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'range', key: 'mouthH', value })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <FxToggle label="Mouth Round" dataKey="mouthRound" checked={profileMouthRound} onChange={(checked) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'toggle', key: 'mouthRound', value: checked })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <FxToggle label="Tears" dataKey="tears" checked={profileTears} onChange={(checked) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'toggle', key: 'tears', value: checked })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              <label className="manual-field">
                <span>Eye Shape</span>
                <select data-fx-expression-select="eyeShape" className="mini-select" value={profileEyeShape} onChange={(event) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'select', key: 'eyeShape', value: event.currentTarget.value })); previewExpression(store, store.getState().fxExpressionSelected); }}>
                  <option value="rect">rect</option>
                  <option value="heart">heart</option>
                </select>
              </label>
              <label className="manual-field">
                <span>Mouth Shape</span>
                <select data-fx-expression-select="mouthShape" className="mini-select" value={profileMouthShape} onChange={(event) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'select', key: 'mouthShape', value: event.currentTarget.value })); previewExpression(store, store.getState().fxExpressionSelected); }}>
                  <option value="rect">rect</option>
                  <option value="frown">frown</option>
                  <option value="smile-arc">smile-arc</option>
                  <option value="round">round</option>
                </select>
              </label>
              <label className="manual-field">
                <span>Color Override</span>
                <input data-fx-expression-color="colorHex" className="fx-color-input" type="color" value={profileColorHex} onChange={(event) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'color', key: 'colorHex', value: normalizeHex(event.currentTarget.value, '#a855f7') })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              </label>
              <label className="manual-field">
                <span>Tear Color</span>
                <input data-fx-expression-color="tearColorHex" className="fx-color-input" type="color" value={profileTearColorHex} onChange={(event) => { void patchFxConfig(store, patchExpressionProfile(store.getState().config, store.getState().fxExpressionSelected, { type: 'color', key: 'tearColorHex', value: normalizeHex(event.currentTarget.value, '#57bfff') })); previewExpression(store, store.getState().fxExpressionSelected); }} />
              </label>
            </div>
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

function ChatPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.chat),
    chatPanelWidth: current.chatPanelWidth,
    chatEntries: current.chatEntries,
    chatVerbosity: current.chatVerbosity,
  }));

  const entries = state.chatEntries.filter((entry) => isChatEntryVisible(state.chatVerbosity, entry.type));

  return (
    <section
      id="chat-panel-card"
      className={`${renderPanelCardClass(state.collapsed)} logs-card chat-panel-top`}
      style={state.chatPanelWidth ? { width: state.chatPanelWidth, maxWidth: '100%' } : undefined}
    >
      <PanelHeader store={store} panelKey="chat" title="Chat" meta={`${state.chatEntries.length} entries`} metaId="chat-panel-meta" />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <ul id="chat-log-list" className="logs chat-log-list">
          {entries.length === 0
            ? <li className="log"><span>No chat yet.</span></li>
            : entries.map((entry) => {
              const actor = resolveChatActor(entry);
              return (
                <li key={entry.id} className={`chat-entry chat-${entry.type} chat-actor-${actor} ${entry.draft ? 'is-draft' : ''}`}>
                  <span className="chat-time">{formatTimestamp(entry.ts)}</span>
                  <span className="chat-text"><strong className="chat-speaker">{renderChatPrefix(entry.type, entry.actor)}</strong> {entry.text}</span>
                </li>
              );
            })}
        </ul>
        <div id="chat-panel-resize" className="panel-resize-handle" aria-hidden="true" />
      </div>
    </section>
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
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="eventLog" title="Event Log" meta={`${state.logs.length} entries`} />
      <div className={`panel-body ${state.collapsed ? 'is-hidden' : ''}`}>
        <ul id="event-log-list" className="logs">
          {state.logs.length === 0
            ? <li className="log"><span>No events yet.</span></li>
            : state.logs.map((entry) => (
              <li key={entry.id} className={`log log-${entry.level}`}>
                <span className="log-time">{formatTimestamp(entry.ts)}</span>
                <span>{entry.text}</span>
              </li>
            ))}
        </ul>
      </div>
    </article>
  );
}

function PanelHeader(props: {
  store: AppStore;
  panelKey: PanelKey;
  title: string;
  meta: string;
  metaId?: string;
}): JSX.Element {
  const collapsed = useAppSelector(props.store, (state) => Boolean(state.collapsedPanels[props.panelKey]));
  return (
    <button
      className="panel-header"
      data-panel-toggle={props.panelKey}
      type="button"
      onClick={() => {
        props.store.setState((current) => ({
          ...current,
          collapsedPanels: {
            ...current.collapsedPanels,
            [props.panelKey]: !current.collapsedPanels[props.panelKey],
          },
        }));
      }}
    >
      <span className="panel-title-wrap">
        <h2>{props.title}</h2>
        <span className="panel-meta" {...(props.metaId ? { id: props.metaId } : {})}>{props.meta}</span>
      </span>
      <span className="panel-toggle-copy">{collapsed ? 'Expand' : 'Collapse'}</span>
    </button>
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

function formatCurrency(value: number | undefined): string {
  if (typeof value !== 'number') return '$0.0000';
  const precision = value >= 1 ? 2 : 4;
  return `$${value.toFixed(precision)}`;
}

function formatUptime(health: AppState['health']): string {
  if (!health?.uptime) return 'n/a';
  return `${health.uptime}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
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

function formatAwakeElapsed(totalSeconds: number): string {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function renderChatPrefix(type: AppState['chatEntries'][number]['type'], actor?: AppState['chatEntries'][number]['actor']): string {
  if (type === 'in') return 'User';
  if (actor === 'small') return 'Mini';
  if (actor === 'main') return 'Tubs';
  if (type === 'sys' || actor === 'system') return 'System';
  return 'Tubs';
}

function resolveChatActor(entry: AppState['chatEntries'][number]): 'user' | 'main' | 'small' | 'system' {
  if (entry.actor === 'main' || entry.actor === 'small' || entry.actor === 'system' || entry.actor === 'user') {
    return entry.actor;
  }
  if (entry.type === 'in') return 'user';
  if (entry.type === 'sys') return 'system';
  return 'main';
}

function isChatEntryVisible(verbosity: AppState['chatVerbosity'], type: AppState['chatEntries'][number]['type']): boolean {
  if (verbosity === 'chat') return type !== 'sys';
  if (verbosity === 'minimal') return type === 'in';
  return true;
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
