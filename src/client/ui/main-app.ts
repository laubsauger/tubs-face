import type { AppState, PanelKey } from '../state/app-state.js';
import { renderFaceVisualMarkup } from './face-visual.js';

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

function formatFaceSummary(state: AppState): string {
  if (state.faceWorkerBusy) return 'Running';
  if (!state.faceWorkerReady) return 'Loading worker';
  return state.faceLastDetectedCount > 0 ? `${state.faceLastDetectedCount} detected` : 'Ready';
}

function isChatEntryVisible(state: AppState, type: AppState['chatEntries'][number]['type']): boolean {
  if (state.chatVerbosity === 'chat') return type !== 'sys';
  if (state.chatVerbosity === 'minimal') return type === 'in';
  return true;
}

export function renderMainApp(root: HTMLElement, state: AppState): void {
  const config = state.config;
  const faceRenderMode = config?.faceRenderMode ?? 'glitch';
  const renderQuality = config?.renderQuality ?? 'high';
  const glitchRenderer = config?.glitchRenderer ?? 'auto';
  const glitchBaseColor = config?.glitchFxBaseColor ?? state.fxBaseColorDraft;
  const glitchPixelSize = config?.glitchPixelSize ?? 21;
  const glitchPixelGap = config?.glitchPixelGap ?? 7;
  const glitchScanlines = config?.glitchScanlines ?? true;
  const glitchScanlineIntensity = config?.glitchScanlineIntensity ?? 0.41;
  const glitchScanlineSpacing = config?.glitchScanlineSpacing ?? 5;
  const glitchScanlineThickness = config?.glitchScanlineThickness ?? 3;
  const glitchScanlineSpeed = config?.glitchScanlineSpeed ?? 26;
  const glitchPixelJitter = config?.glitchPixelJitter ?? 0;
  const glitchFlicker = config?.glitchFlicker ?? true;
  const glitchFlickerSpeed = config?.glitchFlickerSpeed ?? 11;
  const glitchFlickerDepth = config?.glitchFlickerDepth ?? 0.02;
  const glitchGlowStrength = config?.glitchGlowStrength ?? 14;
  const glitchColorHueVariation = config?.glitchColorHueVariation ?? 8;
  const glitchColorBrightnessVariation = config?.glitchColorBrightnessVariation ?? 8;
  const glitchColorOpacityMin = config?.glitchColorOpacityMin ?? 0.5;
  const glitchShapeLeftEyeX = config?.glitchShapeLeftEyeX ?? 0;
  const glitchShapeLeftEyeY = config?.glitchShapeLeftEyeY ?? 0;
  const glitchShapeLeftEyeW = config?.glitchShapeLeftEyeW ?? 14.59;
  const glitchShapeLeftEyeH = config?.glitchShapeLeftEyeH ?? 22.47;
  const glitchShapeLeftEyeRx = config?.glitchShapeLeftEyeRx ?? 5.94;
  const glitchShapeLeftEyeRy = config?.glitchShapeLeftEyeRy ?? 5.94;
  const glitchShapeRightEyeX = config?.glitchShapeRightEyeX ?? 40.85;
  const glitchShapeRightEyeY = config?.glitchShapeRightEyeY ?? 0;
  const glitchShapeRightEyeW = config?.glitchShapeRightEyeW ?? 14.59;
  const glitchShapeRightEyeH = config?.glitchShapeRightEyeH ?? 22.47;
  const glitchShapeRightEyeRx = config?.glitchShapeRightEyeRx ?? 5.94;
  const glitchShapeRightEyeRy = config?.glitchShapeRightEyeRy ?? 5.94;
  const glitchShapeMouthX = config?.glitchShapeMouthX ?? 20.53;
  const glitchShapeMouthY = config?.glitchShapeMouthY ?? 23.86;
  const glitchShapeMouthW = config?.glitchShapeMouthW ?? 14.38;
  const glitchShapeMouthH = config?.glitchShapeMouthH ?? 6.44;
  const glitchShapeMouthRx = config?.glitchShapeMouthRx ?? 1.95;
  const glitchShapeMouthRy = config?.glitchShapeMouthRy ?? 1.95;
  const selectedExpression = state.fxExpressionSelected;
  const selectedProfile = config?.glitchExpressionProfiles?.[selectedExpression] ?? null;
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
  const glitchBrightnessPulseEnabled = config?.glitchBrightnessPulseEnabled ?? true;
  const glitchBrightnessPulseDim = config?.glitchBrightnessPulseDim ?? 0.88;
  const glitchBrightnessPulseBright = config?.glitchBrightnessPulseBright ?? 1;
  const glitchBrightnessPulseSpeed = config?.glitchBrightnessPulseSpeed ?? 3;
  const glitchScanBeamEnabled = config?.glitchScanBeamEnabled ?? true;
  const glitchScanBeamSpeed = config?.glitchScanBeamSpeed ?? 10;
  const glitchScanBeamLineWidth = config?.glitchScanBeamLineWidth ?? 7;
  const glitchScanBeamBrightness = config?.glitchScanBeamBrightness ?? 0.65;
  const glitchScanBeamGlowStrength = config?.glitchScanBeamGlowStrength ?? 26;
  const glitchScanBeamJitter = config?.glitchScanBeamJitter ?? 1;
  const glitchScanBeamColor = config?.glitchScanBeamColor ?? '#a600ff';
  const glitchChromaticEnabled = config?.glitchChromaticEnabled ?? true;
  const glitchChromaticOffsetX = config?.glitchChromaticOffsetX ?? 0;
  const glitchChromaticOffsetY = config?.glitchChromaticOffsetY ?? 4.5;
  const glitchChromaticIntensity = config?.glitchChromaticIntensity ?? 0.65;
  const glitchChromaticAnimate = config?.glitchChromaticAnimate ?? true;
  const glitchChromaticAnimateSpeed = config?.glitchChromaticAnimateSpeed ?? 7;
  const glitchSliceEnabled = config?.glitchSliceEnabled ?? true;
  const glitchSliceCount = config?.glitchSliceCount ?? 24;
  const glitchSliceMaxOffset = config?.glitchSliceMaxOffset ?? 5;
  const glitchSliceSpeed = config?.glitchSliceSpeed ?? 28;
  const glitchSliceIntensity = config?.glitchSliceIntensity ?? 0.53;
  const glitchSliceColorShift = config?.glitchSliceColorShift ?? 0.03;
  const glitchSliceGapChance = config?.glitchSliceGapChance ?? 0.07;
  const glitchSliceIntervalMs = config?.glitchSliceIntervalMs ?? 18000;
  const glitchSliceBurstDurationMs = config?.glitchSliceBurstDurationMs ?? 1800;
  const facesHtml = state.faceLastFaces.map((face, index) => `
    <li class="face-item">
      <div class="face-item-copy">
        <strong>${escapeHtml(face.name ?? face.match?.name ?? `Face ${index + 1}`)}</strong>
        <span>${escapeHtml(renderFaceMeta(face))}</span>
      </div>
      <span>${Math.round((face.match?.score ?? face.confidence ?? face.score) * 100)}%</span>
    </li>
  `).join('');
  const logsHtml = state.logs.map((entry) => `
    <li class="log log-${entry.level}">
      <span class="log-time">${formatTimestamp(entry.ts)}</span>
      <span>${escapeHtml(entry.text)}</span>
    </li>
  `).join('');
  const chatHtml = state.chatEntries
    .filter((entry) => isChatEntryVisible(state, entry.type))
    .map((entry) => `
      <li class="chat-entry chat-${entry.type} chat-actor-${escapeAttribute(resolveChatActor(entry))} ${entry.draft ? 'is-draft' : ''}">
        <span class="chat-time">${formatTimestamp(entry.ts)}</span>
        <span class="chat-text"><strong class="chat-speaker">${escapeHtml(renderChatPrefix(entry.type, entry.actor))}</strong> ${escapeHtml(entry.text)}</span>
      </li>
  `).join('');
  const debugHtml = state.streamDebug.entries.map((entry) => `
    <li class="debug-entry">
      <span class="log-time">${formatTimestamp(entry.ts)}</span>
      <span>${escapeHtml(entry.stage)} ${escapeHtml(formatDebugPayload(entry.payload))}</span>
    </li>
  `).join('');

  root.innerHTML = `
    <main class="shell ${state.uiHidden ? 'shell-ui-hidden' : ''} ${state.fullscreenActive ? 'fullscreen-active' : ''}">
      <section class="hero">
        <div>
          <p class="eyebrow">Tubs Face</p>
          <h1>TypeScript Client Shell</h1>
          <p class="lede">
            Main app entry is now running from <code>src/client/</code> against the TypeScript server core.
          </p>
        </div>
        <div class="hero-actions">
          <button id="window-open-mini" class="button button-secondary" type="button">Open Mini Window</button>
          <button id="window-fullscreen" class="button" type="button">${state.fullscreenActive ? 'Exit Fullscreen' : 'Fullscreen'}</button>
        </div>
      </section>

      <section class="visual-workspace">
        <article class="${renderPanelCardClass(state, 'voice')} voice-panel-card">
          ${renderPanelHeader(state, 'voice', 'Voice', state.listenState, 'voice-panel-meta')}
          <div class="panel-body ${isPanelCollapsed(state, 'voice') ? 'is-hidden' : ''}">
          <dl class="kv">
            <div><dt>Mic</dt><dd id="voice-mic-value">${state.micReady ? 'ready' : state.micDenied ? 'denied' : 'pending'}</dd></div>
            <div><dt>State</dt><dd id="voice-state-value">${escapeHtml(state.listenState)}</dd></div>
            <div><dt>Wake Word</dt><dd id="voice-wakeword-value">${state.voiceWakeWordEnabled ? 'on' : 'off'}</dd></div>
            <div><dt>Mode</dt><dd id="voice-mode-value">${state.voiceHandsFreeEnabled ? 'hands-free' : 'push-to-talk'}</dd></div>
            <div><dt>Playback</dt><dd id="voice-playback-value">${state.audioPlaying ? 'speaking' : 'idle'}</dd></div>
          </dl>
          <div class="voice-meter">
            <span id="voice-meter-bar" class="voice-meter-bar" style="transform: scaleX(${Math.max(0.05, state.micLevel).toFixed(3)});"></span>
          </div>
          <div class="face-actions">
            <div class="face-action-row">
              <button id="voice-enable-mic" class="button button-secondary" type="button">Enable Mic</button>
              <button id="voice-record-button" class="button ${state.recording ? 'button-live' : ''}" type="button">
                ${state.recording ? 'Recording… release to send' : 'Push to Talk'}
              </button>
            </div>
            <label class="voice-toggle">
              <input id="voice-handsfree-toggle" type="checkbox" ${state.voiceHandsFreeEnabled ? 'checked' : ''} />
              <span>Always listen</span>
            </label>
            <label class="voice-toggle">
              <input id="voice-wakeword-toggle" type="checkbox" ${state.voiceWakeWordEnabled ? 'checked' : ''} />
              <span>Require wake word</span>
            </label>
            <p id="voice-last-transcript" class="voice-copy">${escapeHtml(state.voiceLastTranscript || 'Speak naturally or use push-to-talk to send a voice turn.')}</p>
          </div>
          </div>
        </article>

        <section class="visual-shell ${state.sleeping ? 'is-sleeping' : ''}">
          <div id="visual-face" class="visual-face" data-expression="${escapeAttribute(state.currentExpression)}" data-render-mode="${escapeAttribute(faceRenderMode)}">
            ${renderFaceVisualMarkup(state)}
          </div>
          <div id="visual-subtitle" class="visual-subtitle ${state.sleeping ? 'is-hidden' : ''}"></div>
          <div id="visual-live-transcript" class="visual-live-transcript ${state.liveTranscriptText ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}">
            ${escapeHtml(state.liveTranscriptText)}
          </div>
          <div id="visual-donation-card" class="visual-donation-card ${state.currentDonationSignal ? 'is-visible' : ''}">
            <img id="visual-donation-qr" alt="Donation QR" />
            <div class="visual-donation-copy">
              <strong id="visual-donation-handle">Venmo @TubsBot</strong>
              <span id="visual-donation-amount">${escapeHtml(formatDonation(state))}</span>
            </div>
          </div>
        </section>

        <article id="face-panel-card" class="${renderPanelCardClass(state, 'face')} face-panel-card">
          ${renderPanelHeader(state, 'face', 'Face Worker', formatFaceSummary(state))}
          <div class="panel-body ${isPanelCollapsed(state, 'face') ? 'is-hidden' : ''}">
          <p id="face-summary-metric" class="metric ${state.faceWorkerReady ? 'is-good' : 'is-bad'}">${formatFaceSummary(state)}</p>
          <div class="camera-shell">
            <div class="camera-stage">
              <video id="face-camera-video" class="camera-video ${state.faceCameraActive ? '' : 'is-hidden'}" autoplay muted playsinline></video>
              <canvas id="face-camera-overlay" class="camera-overlay ${state.faceCameraActive ? '' : 'is-hidden'}"></canvas>
              <div class="camera-placeholder ${state.faceCameraActive ? 'is-hidden' : ''}">
                Camera inactive
              </div>
            </div>
          </div>
          <div class="face-panel-secondary">
          <dl class="kv">
            <div><dt>Status</dt><dd id="face-status-value">${escapeHtml(state.faceStatus)}</dd></div>
            <div><dt>Inference</dt><dd id="face-inference-value">${state.faceLastInferenceMs == null ? 'n/a' : `${state.faceLastInferenceMs} ms`}</dd></div>
            <div><dt>Embeddings</dt><dd id="face-embeddings-value">${state.faceLastEmbeddingsExtracted} new / ${state.faceLastEmbeddingsReused} cached</dd></div>
            <div><dt>Library</dt><dd id="face-library-value">${state.faceLibraryEmbeddings} embeddings / ${state.faceLibraryPeople} people</dd></div>
          </dl>
          <div class="face-actions">
            <input id="face-upload-input" class="sr-only" type="file" accept="image/png,image/jpeg,image/jpg" />
            <div class="face-action-row">
              <button id="face-camera-toggle" class="button" type="button">
                ${state.faceCameraActive ? 'Stop Camera' : 'Start Camera'}
              </button>
              <button id="face-upload-trigger" class="button" type="button" ${state.faceWorkerBusy ? 'disabled' : ''}>
                ${state.faceWorkerBusy ? 'Processing…' : 'Detect From Image'}
              </button>
              <button id="face-refresh-trigger" class="button button-secondary" type="button">
                Refresh Library
              </button>
            </div>
            <div class="face-action-row">
              <input id="face-enroll-name" class="face-name-input" type="text" placeholder="Name this face" value="${escapeAttribute(state.faceDraftName)}" />
              <button id="face-save-trigger" class="button" type="button" ${!state.faceLastFaces.some((face) => Array.isArray(face.embedding)) ? 'disabled' : ''}>
                Save First Face
              </button>
            </div>
          </div>
          <ul id="face-results-list" class="face-list">
            ${facesHtml || '<li class="face-item face-item-empty">No detections yet.</li>'}
          </ul>
          </div>
          </div>
        </article>
      </section>

      <section class="grid">
        <article class="${renderPanelCardClass(state, 'connection')}">
          ${renderPanelHeader(state, 'connection', 'Connection', state.connectionLabel)}
          <div class="panel-body ${isPanelCollapsed(state, 'connection') ? 'is-hidden' : ''}">
          <p class="metric ${state.connected ? 'is-good' : 'is-bad'}">${state.connectionLabel}</p>
          <dl class="kv">
            <div><dt>Server</dt><dd>${escapeHtml(state.serverUrl)}</dd></div>
            <div><dt>Last WS</dt><dd>${escapeHtml(state.lastMessageType)}</dd></div>
            <div><dt>Ping</dt><dd>${state.lastPingMs == null ? 'n/a' : `${state.lastPingMs} ms`}</dd></div>
          </dl>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'health')}">
          ${renderPanelHeader(state, 'health', 'Health', state.health?.status ?? 'unknown')}
          <div class="panel-body ${isPanelCollapsed(state, 'health') ? 'is-hidden' : ''}">
          <dl class="kv">
            <div><dt>Status</dt><dd>${escapeHtml(state.health?.status ?? 'unknown')}</dd></div>
            <div><dt>Mode</dt><dd>${escapeHtml(state.health?.processingMode ?? 'n/a')}</dd></div>
            <div><dt>Clients</dt><dd>${state.health?.clients ?? 0}</dd></div>
            <div><dt>Uptime</dt><dd>${formatUptime(state.health)}</dd></div>
          </dl>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'config')}">
          ${renderPanelHeader(state, 'config', 'Config', state.config?.llmModel ?? 'n/a')}
          <div class="panel-body ${isPanelCollapsed(state, 'config') ? 'is-hidden' : ''}">
          <dl class="kv">
            <div><dt>Model</dt><dd>${escapeHtml(state.config?.llmModel ?? 'n/a')}</dd></div>
            <div><dt>Render</dt><dd>${escapeHtml(faceRenderMode)}</dd></div>
            <div><dt>Quality</dt><dd>${escapeHtml(renderQuality)}</dd></div>
            <div><dt>Muted</dt><dd>${config?.muted ? 'yes' : 'no'}</dd></div>
            <div><dt>Ambient</dt><dd>${state.ambientAudioEnabled ? 'on' : 'off'}</dd></div>
          </dl>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'stats')}">
          ${renderPanelHeader(state, 'stats', 'Stats', `${state.stats?.tokensOut ?? 0} out`)}
          <div class="panel-body ${isPanelCollapsed(state, 'stats') ? 'is-hidden' : ''}">
          <dl class="kv">
            <div><dt>Tokens In</dt><dd>${state.stats?.tokensIn ?? 0}</dd></div>
            <div><dt>Tokens Out</dt><dd>${state.stats?.tokensOut ?? 0}</dd></div>
            <div><dt>Cost</dt><dd>${formatCurrency(state.stats?.costUsd)}</dd></div>
            <div><dt>Model</dt><dd>${escapeHtml(state.stats?.model ?? state.config?.model ?? 'n/a')}</dd></div>
          </dl>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'assistant')}">
          ${renderPanelHeader(state, 'assistant', 'Assistant', state.currentExpression, 'assistant-panel-meta')}
          <div class="panel-body ${isPanelCollapsed(state, 'assistant') ? 'is-hidden' : ''}">
          <dl class="kv">
            <div><dt>Expression</dt><dd id="assistant-expression-value">${escapeHtml(state.currentExpression)}</dd></div>
            <div><dt>Sleep</dt><dd id="assistant-sleep-value">${state.sleeping ? 'asleep' : 'awake'}</dd></div>
            <div><dt>Conversation</dt><dd id="assistant-conversation-value">${state.conversationActive ? 'active' : 'idle'}</dd></div>
            <div><dt>Awake</dt><dd id="assistant-awake-value">${formatAwakeElapsed(state.awakeElapsedSec)}</dd></div>
            <div><dt>Turn</dt><dd id="assistant-turn-value">${escapeHtml(state.currentTurnId ?? 'n/a')}</dd></div>
            <div><dt>Mood</dt><dd id="assistant-mood-value">${state.moodPos.toFixed(2)} / ${state.moodNeg.toFixed(2)} / ${state.moodArousal.toFixed(2)}</dd></div>
          </dl>
          <div class="assistant-copy">
            <p><strong>User</strong> <span id="assistant-user-copy">${escapeHtml(state.currentIncomingText || 'No incoming text yet.')}</span></p>
            <p><strong>Tubs</strong> <span id="assistant-speech-copy">${escapeHtml(state.currentSpeechText || 'No spoken output yet.')}</span></p>
            <p><strong>Donation</strong> <span id="assistant-donation-copy">${escapeHtml(formatDonation(state))}</span></p>
          </div>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'controls')}">
          ${renderPanelHeader(state, 'controls', 'Controls', 'Actions')}
          <div class="panel-body ${isPanelCollapsed(state, 'controls') ? 'is-hidden' : ''}">
          <div class="face-actions">
            <div class="face-action-row">
              <button id="chat-verbosity-toggle" class="button button-secondary" type="button">Verbosity ${escapeHtml(state.chatVerbosity.toUpperCase())}</button>
              <button id="ambient-toggle" class="button button-secondary" type="button">Ambient ${state.ambientAudioEnabled ? 'On' : 'Off'}</button>
            </div>
            <div class="face-action-row">
              <button id="action-wake" class="button button-secondary" type="button">Wake</button>
              <button id="action-sleep" class="button button-secondary" type="button">Sleep</button>
            </div>
            <div class="face-action-row">
              <input id="action-speak-text" class="face-name-input" type="text" value="${escapeAttribute(state.controlSpeakText)}" />
              <button id="action-speak" class="button" type="button">Speak</button>
            </div>
            <div class="face-action-row">
              <input id="action-donation-amount" class="face-name-input" type="text" value="${escapeAttribute(state.controlDonationAmount)}" />
              <button id="action-donate" class="button" type="button">Signal Donation</button>
            </div>
          </div>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'fx')}">
          ${renderPanelHeader(state, 'fx', 'FX', config?.glitchFxEnabled ? 'glitch on' : 'glitch off')}
          <div class="panel-body ${isPanelCollapsed(state, 'fx') ? 'is-hidden' : ''}">
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
              <button id="fx-editor-open" class="button button-secondary" type="button">${state.fxEditorOpen ? 'Editor Open' : 'Open Editor'}</button>
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
              <input id="fx-base-color" class="fx-color-input" type="color" value="${escapeAttribute(state.fxBaseColorDraft)}" />
              <button id="fx-color-apply" class="button button-secondary" type="button">Apply Color</button>
            </div>
            <div class="fx-editor-shell ${state.fxEditorOpen ? 'is-open' : ''}">
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
                ${renderFxSelect('Eye Shape', 'eyeShape', profileEyeShape, ['rect', 'heart'], 'expression-select')}
                ${renderFxSelect('Mouth Shape', 'mouthShape', profileMouthShape, ['rect', 'frown', 'smile-arc', 'round'], 'expression-select')}
                ${renderFxColor('Color Override', 'colorHex', profileColorHex, 'expression-color')}
                ${renderFxColor('Tear Color', 'tearColorHex', profileTearColorHex, 'expression-color')}
              </div>
              <div class="fx-editor-group">
                <h3>Pixel Grid</h3>
                ${renderFxSlider('Pixel Size', 'glitchPixelSize', glitchPixelSize, 2, 60, 1)}
                ${renderFxSlider('Pixel Gap', 'glitchPixelGap', glitchPixelGap, 0, 30, 1)}
              </div>
              <div class="fx-editor-group">
                <h3>Base Shapes</h3>
                ${renderFxSlider('Left Eye X', 'glitchShapeLeftEyeX', glitchShapeLeftEyeX, -10, 60, 0.1)}
                ${renderFxSlider('Left Eye Y', 'glitchShapeLeftEyeY', glitchShapeLeftEyeY, -10, 40, 0.1)}
                ${renderFxSlider('Left Eye W', 'glitchShapeLeftEyeW', glitchShapeLeftEyeW, 1, 30, 0.1)}
                ${renderFxSlider('Left Eye H', 'glitchShapeLeftEyeH', glitchShapeLeftEyeH, 1, 40, 0.1)}
                ${renderFxSlider('Left Eye Rx', 'glitchShapeLeftEyeRx', glitchShapeLeftEyeRx, 0, 15, 0.1)}
                ${renderFxSlider('Left Eye Ry', 'glitchShapeLeftEyeRy', glitchShapeLeftEyeRy, 0, 15, 0.1)}
                ${renderFxSlider('Right Eye X', 'glitchShapeRightEyeX', glitchShapeRightEyeX, 0, 60, 0.1)}
                ${renderFxSlider('Right Eye Y', 'glitchShapeRightEyeY', glitchShapeRightEyeY, -10, 40, 0.1)}
                ${renderFxSlider('Right Eye W', 'glitchShapeRightEyeW', glitchShapeRightEyeW, 1, 30, 0.1)}
                ${renderFxSlider('Right Eye H', 'glitchShapeRightEyeH', glitchShapeRightEyeH, 1, 40, 0.1)}
                ${renderFxSlider('Right Eye Rx', 'glitchShapeRightEyeRx', glitchShapeRightEyeRx, 0, 15, 0.1)}
                ${renderFxSlider('Right Eye Ry', 'glitchShapeRightEyeRy', glitchShapeRightEyeRy, 0, 15, 0.1)}
                ${renderFxSlider('Mouth X', 'glitchShapeMouthX', glitchShapeMouthX, 0, 60, 0.1)}
                ${renderFxSlider('Mouth Y', 'glitchShapeMouthY', glitchShapeMouthY, 0, 40, 0.1)}
                ${renderFxSlider('Mouth W', 'glitchShapeMouthW', glitchShapeMouthW, 1, 30, 0.1)}
                ${renderFxSlider('Mouth H', 'glitchShapeMouthH', glitchShapeMouthH, 1, 20, 0.1)}
                ${renderFxSlider('Mouth Rx', 'glitchShapeMouthRx', glitchShapeMouthRx, 0, 15, 0.1)}
                ${renderFxSlider('Mouth Ry', 'glitchShapeMouthRy', glitchShapeMouthRy, 0, 15, 0.1)}
              </div>
              <div class="fx-editor-group">
                <h3>Color</h3>
                ${renderFxSlider('Hue Variation', 'glitchColorHueVariation', glitchColorHueVariation, 0, 60, 1)}
                ${renderFxSlider('Brightness Var', 'glitchColorBrightnessVariation', glitchColorBrightnessVariation, 0, 40, 1)}
                ${renderFxSlider('Opacity Min', 'glitchColorOpacityMin', glitchColorOpacityMin, 0, 1, 0.05)}
              </div>
              <div class="fx-editor-group">
                <h3>Scanlines & Flicker</h3>
                ${renderFxToggle('Scanlines', 'glitchScanlines', glitchScanlines)}
                ${renderFxSlider('Scanline Intensity', 'glitchScanlineIntensity', glitchScanlineIntensity, 0, 1, 0.01)}
                ${renderFxSlider('Scanline Spacing', 'glitchScanlineSpacing', glitchScanlineSpacing, 1, 20, 1)}
                ${renderFxSlider('Scanline Thickness', 'glitchScanlineThickness', glitchScanlineThickness, 1, 10, 1)}
                ${renderFxSlider('Scanline Speed', 'glitchScanlineSpeed', glitchScanlineSpeed, 1, 60, 1)}
                ${renderFxSlider('Pixel Jitter', 'glitchPixelJitter', glitchPixelJitter, 0, 10, 0.1)}
                ${renderFxToggle('Flicker', 'glitchFlicker', glitchFlicker)}
                ${renderFxSlider('Flicker Speed', 'glitchFlickerSpeed', glitchFlickerSpeed, 1, 30, 1)}
                ${renderFxSlider('Flicker Depth', 'glitchFlickerDepth', glitchFlickerDepth, 0, 0.2, 0.005)}
                ${renderFxSlider('Glow Strength', 'glitchGlowStrength', glitchGlowStrength, 0, 60, 1)}
              </div>
              <div class="fx-editor-group">
                <h3>Brightness Pulse</h3>
                ${renderFxToggle('Pulse Enabled', 'glitchBrightnessPulseEnabled', glitchBrightnessPulseEnabled)}
                ${renderFxSlider('Pulse Dim', 'glitchBrightnessPulseDim', glitchBrightnessPulseDim, 0.3, 1, 0.01)}
                ${renderFxSlider('Pulse Bright', 'glitchBrightnessPulseBright', glitchBrightnessPulseBright, 0.5, 1.5, 0.01)}
                ${renderFxSlider('Pulse Speed', 'glitchBrightnessPulseSpeed', glitchBrightnessPulseSpeed, 0.5, 15, 0.5)}
              </div>
              <div class="fx-editor-group">
                <h3>Scan Beam</h3>
                ${renderFxToggle('Beam Enabled', 'glitchScanBeamEnabled', glitchScanBeamEnabled)}
                ${renderFxSlider('Beam Speed', 'glitchScanBeamSpeed', glitchScanBeamSpeed, 1, 40, 1)}
                ${renderFxSlider('Beam Width', 'glitchScanBeamLineWidth', glitchScanBeamLineWidth, 1, 30, 1)}
                ${renderFxSlider('Beam Brightness', 'glitchScanBeamBrightness', glitchScanBeamBrightness, 0, 1, 0.05)}
                ${renderFxSlider('Beam Glow', 'glitchScanBeamGlowStrength', glitchScanBeamGlowStrength, 0, 60, 1)}
                ${renderFxSlider('Beam Jitter', 'glitchScanBeamJitter', glitchScanBeamJitter, 0, 10, 0.5)}
                <div class="face-action-row">
                  <input id="fx-scanbeam-color" class="fx-color-input" type="color" value="${escapeAttribute(glitchScanBeamColor)}" />
                  <button id="fx-scanbeam-color-apply" class="button button-secondary" type="button">Apply Beam Color</button>
                </div>
              </div>
              <div class="fx-editor-group">
                <h3>Chromatic</h3>
                ${renderFxToggle('Chromatic Enabled', 'glitchChromaticEnabled', glitchChromaticEnabled)}
                ${renderFxSlider('Chromatic X', 'glitchChromaticOffsetX', glitchChromaticOffsetX, -10, 10, 0.1)}
                ${renderFxSlider('Chromatic Y', 'glitchChromaticOffsetY', glitchChromaticOffsetY, -10, 10, 0.1)}
                ${renderFxSlider('Chromatic Intensity', 'glitchChromaticIntensity', glitchChromaticIntensity, 0, 1, 0.05)}
                ${renderFxToggle('Chromatic Animate', 'glitchChromaticAnimate', glitchChromaticAnimate)}
                ${renderFxSlider('Animate Speed', 'glitchChromaticAnimateSpeed', glitchChromaticAnimateSpeed, 1, 20, 1)}
              </div>
              <div class="fx-editor-group">
                <h3>Glitch Slice</h3>
                ${renderFxToggle('Slice Enabled', 'glitchSliceEnabled', glitchSliceEnabled)}
                ${renderFxSlider('Slice Count', 'glitchSliceCount', glitchSliceCount, 2, 60, 1)}
                ${renderFxSlider('Slice Max Offset', 'glitchSliceMaxOffset', glitchSliceMaxOffset, 0, 30, 1)}
                ${renderFxSlider('Slice Speed', 'glitchSliceSpeed', glitchSliceSpeed, 1, 60, 1)}
                ${renderFxSlider('Slice Intensity', 'glitchSliceIntensity', glitchSliceIntensity, 0, 1, 0.01)}
                ${renderFxSlider('Slice Color Shift', 'glitchSliceColorShift', glitchSliceColorShift, 0, 0.2, 0.01)}
                ${renderFxSlider('Slice Gap Chance', 'glitchSliceGapChance', glitchSliceGapChance, 0, 0.5, 0.01)}
                ${renderFxSlider('Burst Interval', 'glitchSliceIntervalMs', glitchSliceIntervalMs, 1000, 60000, 1000)}
                ${renderFxSlider('Burst Duration', 'glitchSliceBurstDurationMs', glitchSliceBurstDurationMs, 200, 8000, 100)}
              </div>
            </div>
          </div>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'manual')}">
          ${renderPanelHeader(state, 'manual', 'Manual Beats', state.manualStatus)}
          <div class="panel-body ${isPanelCollapsed(state, 'manual') ? 'is-hidden' : ''}">
            <div class="manual-beats-row">
              <button id="manual-beats-toggle" class="button button-secondary" type="button">${state.manualComposerOpen ? 'Close' : 'Open'}</button>
              <select id="manual-beats-mode" class="mini-select">
                <option value="single" ${state.manualComposerMode === 'single' ? 'selected' : ''}>Single Beat</option>
                <option value="script" ${state.manualComposerMode === 'script' ? 'selected' : ''}>Script JSON</option>
              </select>
            </div>
            <div class="manual-beats-shell ${state.manualComposerOpen ? 'is-open' : ''}">
              <div id="manual-single-fields" class="manual-fields-grid ${state.manualComposerMode === 'script' ? 'is-hidden' : ''}">
                <div class="manual-beats-row">
                  <label class="manual-field">
                    <span>Actor</span>
                    <select id="manual-beat-actor" class="mini-select">
                      <option value="main" ${state.manualActor === 'main' ? 'selected' : ''}>Main</option>
                      <option value="small" ${state.manualActor === 'small' ? 'selected' : ''}>Small</option>
                    </select>
                  </label>
                  <label class="manual-field">
                    <span>Action</span>
                    <select id="manual-beat-action" class="mini-select">
                      <option value="speak" ${state.manualAction === 'speak' ? 'selected' : ''}>Speak</option>
                      <option value="react" ${state.manualAction === 'react' ? 'selected' : ''}>React</option>
                      <option value="wait" ${state.manualAction === 'wait' ? 'selected' : ''}>Wait</option>
                    </select>
                  </label>
                </div>
                <div class="manual-beats-row">
                  <label class="manual-field">
                    <span>Expression</span>
                    <input id="manual-beat-expression" class="face-name-input" type="text" value="${escapeAttribute(state.manualExpression)}" />
                  </label>
                  <label class="manual-field">
                    <span>Emoji</span>
                    <input id="manual-beat-emoji" class="face-name-input" type="text" value="${escapeAttribute(state.manualEmoji)}" />
                  </label>
                </div>
                <div class="manual-beats-row">
                  <label class="manual-field">
                    <span>Delay Ms</span>
                    <input id="manual-beat-delay" class="face-name-input" type="text" value="${escapeAttribute(state.manualDelay)}" />
                  </label>
                </div>
                <label class="manual-field">
                  <span>Text</span>
                  <textarea id="manual-beat-text" class="manual-textarea" rows="4">${escapeHtml(state.manualText)}</textarea>
                </label>
              </div>
              <div id="manual-script-fields" class="${state.manualComposerMode === 'script' ? '' : 'is-hidden'}">
                <label class="manual-field">
                  <span>Script JSON</span>
                  <textarea id="manual-script-json" class="manual-textarea" rows="10">${escapeHtml(state.manualScript)}</textarea>
                </label>
              </div>
              <div class="manual-beats-actions">
                <button id="manual-beats-send" class="button" type="button" ${state.manualSending ? 'disabled' : ''}>${state.manualSending ? 'Sending...' : 'Send'}</button>
                <button id="manual-beats-template" class="button button-secondary" type="button">Valentine</button>
                <button id="manual-beats-clear" class="button button-secondary" type="button">Clear</button>
              </div>
              <div class="manual-beats-status ${renderManualStatusClass(state)}">${escapeHtml(state.manualStatus)}</div>
            </div>
          </div>
        </article>

      </section>

      <section id="chat-panel-card" class="${renderPanelCardClass(state, 'chat')} logs-card chat-panel-top"${renderChatPanelStyle(state)}>
        ${renderPanelHeader(state, 'chat', 'Chat', `${state.chatEntries.length} entries`, 'chat-panel-meta')}
        <div class="panel-body ${isPanelCollapsed(state, 'chat') ? 'is-hidden' : ''}">
          <ul id="chat-log-list" class="logs chat-log-list">
            ${chatHtml || '<li class="log"><span>No chat yet.</span></li>'}
          </ul>
          <div id="chat-panel-resize" class="panel-resize-handle" aria-hidden="true"></div>
        </div>
      </section>

      <section class="grid">
        <article class="${renderPanelCardClass(state, 'streamDebug')}">
          ${renderPanelHeader(state, 'streamDebug', 'Stream Debug', state.streamDebug.enabled ? (state.streamDebug.currentTurnId?.slice(0, 8) ?? 'none') : 'disabled', 'stream-debug-panel-meta')}
          <div class="panel-body ${isPanelCollapsed(state, 'streamDebug') ? 'is-hidden' : ''}">
          <div class="face-action-row">
            <button id="stream-debug-toggle" class="button button-secondary" type="button">${state.streamDebug.enabled ? 'Disable Debug' : 'Enable Debug'}</button>
            <button id="stream-debug-clear" class="button button-secondary" type="button">Clear</button>
          </div>
          <dl class="kv">
            <div><dt>LLM</dt><dd id="stream-debug-llm-value">${state.streamDebug.llmDeltas}/${state.streamDebug.llmChars}</dd></div>
            <div><dt>Sentences</dt><dd id="stream-debug-sentences-value">${state.streamDebug.sentences}</dd></div>
            <div><dt>TTS Out</dt><dd id="stream-debug-tts-value">${state.streamDebug.ttsSentences}/${state.streamDebug.ttsChars}</dd></div>
            <div><dt>Audio In</dt><dd id="stream-debug-audio-in-value">${state.streamDebug.audioChunksIn}/${Math.round(state.streamDebug.audioBytesIn / 1024)}KB</dd></div>
            <div><dt>Played</dt><dd id="stream-debug-played-value">${state.streamDebug.audioChunksPlayed}/${state.streamDebug.audioSecondsPlayed.toFixed(2)}s</dd></div>
          </dl>
          <ul id="stream-debug-list" class="logs">
            ${state.streamDebug.enabled
              ? (debugHtml || '<li class="log"><span>No stream events yet.</span></li>')
              : '<li class="log"><span>Stream debug disabled.</span></li>'}
          </ul>
          </div>
        </article>

        <article class="${renderPanelCardClass(state, 'eventLog')}">
          ${renderPanelHeader(state, 'eventLog', 'Event Log', `${state.logs.length} entries`)}
          <div class="panel-body ${isPanelCollapsed(state, 'eventLog') ? 'is-hidden' : ''}">
          <ul id="event-log-list" class="logs">
            ${logsHtml || '<li class="log"><span>No events yet.</span></li>'}
          </ul>
          </div>
        </article>
      </section>
    </main>
  `;
}

function renderChatPrefix(type: AppState['chatEntries'][number]['type'], actor?: AppState['chatEntries'][number]['actor']): string {
  if (type === 'in') return 'User';
  if (actor === 'small') return 'Mini';
  if (actor === 'main') return 'Tubs';
  if (type === 'sys' || actor === 'system') return 'System';
  return 'Tubs';
}

function formatDebugPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([key]) => key !== 'ts')
    .slice(0, 5)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

function formatDonation(state: AppState): string {
  const signal = state.currentDonationSignal;
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

function isPanelCollapsed(state: AppState, key: PanelKey): boolean {
  return Boolean(state.collapsedPanels[key]);
}

function renderPanelCardClass(state: AppState, key: PanelKey): string {
  return `card panel-card ${isPanelCollapsed(state, key) ? 'is-collapsed' : ''}`;
}

function renderPanelHeader(state: AppState, key: PanelKey, title: string, meta: string, metaId?: string): string {
  return `
    <button class="panel-header" data-panel-toggle="${escapeAttribute(key)}" type="button">
      <span class="panel-title-wrap">
        <h2>${escapeHtml(title)}</h2>
        <span class="panel-meta"${metaId ? ` id="${escapeAttribute(metaId)}"` : ''}>${escapeHtml(meta)}</span>
      </span>
      <span class="panel-toggle-copy">${isPanelCollapsed(state, key) ? 'Expand' : 'Collapse'}</span>
    </button>
  `;
}

function renderChatPanelStyle(state: AppState): string {
  return state.chatPanelWidth ? ` style="width:${state.chatPanelWidth}px;max-width:100%;"` : '';
}

function resolveChatActor(entry: AppState['chatEntries'][number]): 'user' | 'main' | 'small' | 'system' {
  if (entry.actor === 'main' || entry.actor === 'small' || entry.actor === 'system' || entry.actor === 'user') {
    return entry.actor;
  }
  if (entry.type === 'in') return 'user';
  if (entry.type === 'sys') return 'system';
  return 'main';
}

function renderManualStatusClass(state: AppState): string {
  return state.manualStatusKind === 'ok'
    ? 'is-ok'
    : state.manualStatusKind === 'error'
      ? 'is-error'
      : state.manualStatusKind === 'busy'
        ? 'is-busy'
        : '';
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
  const datasetAttribute = datasetType === 'expression-range'
    ? 'data-fx-expression-range'
    : 'data-fx-config-range';
  return `
    <label class="fx-slider-row">
      <span>${escapeHtml(label)}</span>
      <input ${datasetAttribute}="${escapeAttribute(key)}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />
      <strong>${value.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 3)}</strong>
    </label>
  `;
}

function renderFxToggle(
  label: string,
  key: string,
  checked: boolean,
  datasetType: 'config-toggle' | 'expression-toggle' = 'config-toggle',
): string {
  const datasetAttribute = datasetType === 'expression-toggle'
    ? 'data-fx-expression-toggle'
    : 'data-fx-config-toggle';
  return `
    <label class="voice-toggle fx-toggle-row">
      <input ${datasetAttribute}="${escapeAttribute(key)}" type="checkbox" ${checked ? 'checked' : ''} />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function renderFxSelect(
  label: string,
  key: string,
  value: string,
  options: string[],
  datasetType: 'expression-select',
): string {
  const datasetAttribute = datasetType === 'expression-select' ? 'data-fx-expression-select' : '';
  return `
    <label class="manual-field">
      <span>${escapeHtml(label)}</span>
      <select ${datasetAttribute}="${escapeAttribute(key)}" class="mini-select">
        ${options.map((option) => `<option value="${escapeAttribute(option)}" ${value === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
      </select>
    </label>
  `;
}

function renderFxColor(
  label: string,
  key: string,
  value: `#${string}`,
  datasetType: 'expression-color',
): string {
  const datasetAttribute = datasetType === 'expression-color' ? 'data-fx-expression-color' : '';
  return `
    <label class="manual-field">
      <span>${escapeHtml(label)}</span>
      <input ${datasetAttribute}="${escapeAttribute(key)}" class="fx-color-input" type="color" value="${escapeAttribute(value)}" />
    </label>
  `;
}

function renderExpressionOption(name: string, selected: string): string {
  return `<option value="${escapeAttribute(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
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
