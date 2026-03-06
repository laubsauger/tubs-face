import { createAppActionsRuntime } from './actions/runtime.js';
import { createAmbientRuntime } from './audio/ambient-runtime.js';
import { createSpeechRuntime } from './audio/speech-runtime.js';
import { createVoiceRuntime } from './audio/voice-runtime.js';
import { createFaceBehaviorRuntime } from './face/behavior-runtime.js';
import { createFxRuntime } from './fx/runtime.js';
import { createGlitchRuntime } from './glitch/runtime.js';
import { createEmotionRuntime } from './behavior/emotion-runtime.js';
import { createProactiveRuntime } from './behavior/proactive-runtime.js';
import { createManualRuntime } from './manual/runtime.js';
import type { AppStore } from './state/app-state.js';
import type { ConfigResponse, HealthResponse, StatsResponse } from '../shared/contracts/http.js';
import type { WsServerMessage } from '../shared/contracts/ws.js';
import { applyServerMessage } from './handlers/messages.js';
import { createFaceShellRuntime } from './face/runtime.js';
import { createAppStore } from './state/app-state.js';
import { fetchJson } from './transport/http.js';
import { createManagedWsClient } from './transport/ws-client.js';
import { createVisualRuntime } from './ui/visual-runtime.js';
import { createWindowRuntime } from './ui/window-runtime.js';
import { createPanelRuntime } from './ui/panel-runtime.js';

export interface BootstrapOptions {
  mode: 'main' | 'mini';
  root: HTMLElement;
  render: (root: HTMLElement, state: ReturnType<AppStore['getState']>) => void;
}

export async function bootstrapClient(options: BootstrapOptions): Promise<void> {
  const store = createAppStore(window.location.host);
  const actionsRuntime = options.mode === 'main' ? createAppActionsRuntime(store) : null;
  const ambientRuntime = createAmbientRuntime(store, options.mode);
  const emotionRuntime = options.mode === 'main' ? createEmotionRuntime(store) : null;
  const manualRuntime = options.mode === 'main' ? createManualRuntime(store) : null;
  const fxRuntime = options.mode === 'main' ? createFxRuntime(store) : null;
  const glitchRuntime = createGlitchRuntime(store);
  const panelRuntime = options.mode === 'main' ? createPanelRuntime(store) : null;
  const proactiveRuntime = options.mode === 'main' ? createProactiveRuntime(store) : null;
  const speechRuntime = options.mode === 'main' ? createSpeechRuntime(store) : null;
  const visualRuntime = createVisualRuntime(store);
  const voiceRuntime = options.mode === 'main' ? createVoiceRuntime(store) : null;
  const faceBehaviorRuntime = options.mode === 'main' ? createFaceBehaviorRuntime(store) : null;
  const faceRuntime = options.mode === 'main' ? createFaceShellRuntime(store) : null;
  const windowRuntime = createWindowRuntime(store, options.mode);

  store.subscribe((state) => {
    options.render(options.root, state);
    actionsRuntime?.bind(options.root);
    ambientRuntime.bind(options.root);
    fxRuntime?.bind(options.root);
    glitchRuntime.bind(options.root);
    manualRuntime?.bind(options.root);
    panelRuntime?.bind(options.root);
    speechRuntime?.bind(options.root);
    visualRuntime.bind(options.root);
    voiceRuntime?.bind(options.root);
    faceBehaviorRuntime?.bind(options.root);
    faceRuntime?.bind(options.root);
    windowRuntime.bind(options.root);
  });

  store.appendLog('info', `${options.mode} client booting`);

  await loadInitialState(store);
  ambientRuntime.init();
  fxRuntime?.init();
  glitchRuntime.init();
  panelRuntime?.init();
  speechRuntime?.init();
  await voiceRuntime?.init();
  faceBehaviorRuntime?.init();
  faceRuntime?.init();
  windowRuntime.init();
  emotionRuntime?.init();

  const wsClient = createManagedWsClient({
    onOpen: () => {
      store.setState((current) => ({
        ...current,
        connected: true,
        connectionLabel: 'Online',
      }));
      store.appendLog('info', 'WebSocket connected');
    },
    onClose: () => {
      store.setState((current) => ({
        ...current,
        connected: false,
        connectionLabel: 'Reconnecting',
      }));
      store.appendLog('error', 'WebSocket disconnected');
    },
    onError: () => {
      store.appendLog('error', 'WebSocket error');
    },
    onMessage: (message: WsServerMessage) => {
      if (message.type === 'incoming' || message.type === 'speak' || message.type === 'turn_script' || message.type === 'donation_signal') {
        proactiveRuntime?.onActivity();
      }
      if (message.type === 'speak' && message.emotion?.impulse) {
        emotionRuntime?.pushImpulse(message.emotion.impulse, 'spoken');
      }
      if (message.type === 'thinking') {
        emotionRuntime?.pushImpulse({ arousal: 0.52 }, 'system');
      }
      if (message.type === 'donation_signal') {
        emotionRuntime?.pushImpulse({ pos: 1, neg: 0, arousal: 0.85 }, 'system');
      }
      speechRuntime?.handleServerMessage(message);
      applyServerMessage(store, message);
      proactiveRuntime?.onPresenceChanged();
    },
  });

  faceBehaviorRuntime?.attachSender((message) => {
    wsClient.send(message);
  });

  window.addEventListener('tubs:head-speech-state', ((event: Event) => {
    const detail = (event as CustomEvent<{ actor?: 'main' | 'small'; state?: 'start' | 'end'; turnId?: string | null; ts?: number; durationMs?: number }>).detail;
    wsClient.send({
      type: 'head_speech_state',
      actor: detail?.actor === 'small' ? 'small' : 'main',
      state: detail?.state === 'end' ? 'end' : 'start',
      ...(detail?.turnId !== undefined ? { turnId: detail.turnId } : {}),
      ts: detail?.ts ?? Date.now(),
      ...(detail?.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
    });
  }) as EventListener);

  proactiveRuntime?.init((message) => {
    wsClient.send(message);
  });
  wsClient.connect();
}

async function loadInitialState(store: AppStore): Promise<void> {
  try {
    const [health, config, stats] = await Promise.all([
      fetchJson<HealthResponse>('/health'),
      fetchJson<ConfigResponse>('/config'),
      fetchJson<StatsResponse>('/stats'),
    ]);

    store.setState((current) => ({
      ...current,
      health,
      config,
      stats,
      fxBaseColorDraft: config.glitchFxBaseColor,
      connectionLabel: current.connected ? current.connectionLabel : 'HTTP ready',
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load initial state';
    store.appendLog('error', message);
  }
}
