import { createRoot } from 'react-dom/client';
import { createAmbientRuntime } from './audio/ambient-runtime.js';
import { createSpeechRuntime } from './audio/speech-runtime.js';
import { createVoiceRuntime } from './audio/voice-runtime.js';
import { createEmotionRuntime } from './behavior/emotion-runtime.js';
import { createProactiveRuntime } from './behavior/proactive-runtime.js';
import { createFaceBehaviorRuntime } from './face/behavior-runtime.js';
import { createFaceShellRuntime } from './face/runtime.js';
import { createFxRuntime } from './fx/runtime.js';
import { createGlitchRuntime } from './glitch/runtime.js';
import { applyServerMessage } from './handlers/messages.js';
import { createAppStore, type AppState, type AppStore } from './state/app-state.js';
import { fetchJson } from './transport/http.js';
import { createManagedWsClient } from './transport/ws-client.js';
import { createVisualRuntime } from './ui/visual-runtime.js';
import { createWindowRuntime } from './ui/window-runtime.js';
import { AppShell, type AppShellControls } from './ui/app-shell.js';
import type { ConfigResponse, HealthResponse, StatsResponse } from '../shared/contracts/http.js';
import type { WsServerMessage } from '../shared/contracts/ws.js';

export interface BootstrapOptions {
  mode: 'main' | 'mini';
  root: HTMLElement;
}

export async function bootstrapClient(options: BootstrapOptions): Promise<void> {
  const store = createAppStore(resolveServerLabel());
  const ambientRuntime = createAmbientRuntime(store, options.mode);
  const emotionRuntime = options.mode === 'main' ? createEmotionRuntime(store) : null;
  const fxRuntime = options.mode === 'main' ? createFxRuntime(store) : null;
  const glitchRuntime = createGlitchRuntime(store, options.mode);
  const proactiveRuntime = options.mode === 'main' ? createProactiveRuntime(store) : null;
  const speechRuntime = createSpeechRuntime(store, options.mode);
  const visualRuntime = createVisualRuntime(store, options.mode);
  const voiceRuntime = options.mode === 'main' ? createVoiceRuntime(store) : null;
  const faceBehaviorRuntime = createFaceBehaviorRuntime(store, options.mode);
  const faceRuntime = options.mode === 'main' ? createFaceShellRuntime(store) : null;
  const windowRuntime = createWindowRuntime(store, options.mode);

  const controls: AppShellControls | undefined = options.mode === 'main'
    ? {
      ambient: {
        toggleEnabled: () => ambientRuntime.toggleEnabled(),
      },
      ...(voiceRuntime ? {
        voice: {
          enableMic: () => voiceRuntime.enableMic(),
          startManualRecording: () => voiceRuntime.startManualRecording(),
          stopManualRecording: () => voiceRuntime.stopManualRecording(),
        },
      } : {}),
      ...(faceRuntime ? {
        face: {
          toggleCamera: async () => {
            if (store.getState().faceCameraActive) {
              faceRuntime.stopCamera();
            } else {
              await faceRuntime.startCamera();
            }
          },
          detectFile: (file: File) => faceRuntime.detectFile(file),
          saveDetectedFace: () => faceRuntime.saveDetectedFace(),
          refreshLibrary: () => faceRuntime.refreshLibrary(),
        },
      } : {}),
    }
    : undefined;

  const reactRoot = createRoot(options.root);
  reactRoot.render(
    <AppShell
      mode={options.mode}
      store={store}
      {...(controls ? { controls } : {})}
    />,
  );

  const bindInteractiveRuntimes = () => {
    speechRuntime.bind(options.root);
    faceBehaviorRuntime.bind(options.root);
    faceRuntime?.bind(options.root);
  };
  window.requestAnimationFrame(() => {
    bindInteractiveRuntimes();
    visualRuntime.bind(options.root);
    glitchRuntime.bind(options.root);
  });

  store.subscribeSelector(selectVisualSlice, () => {
    visualRuntime.bind(options.root);
  }, {
    equalityFn: shallowEqual,
    fireImmediately: false,
  });

  store.subscribeSelector(selectGlitchSlice, () => {
    glitchRuntime.bind(options.root);
  }, {
    equalityFn: shallowEqual,
    fireImmediately: false,
  });

  if (faceRuntime) {
    store.subscribeSelector(
      (state: AppState) => state.faceCameraActive,
      () => {
        window.requestAnimationFrame(() => {
          faceRuntime.bind(options.root);
        });
      },
      { fireImmediately: false },
    );
  }

  store.appendLog('info', `${options.mode} client booting`);

  window.setInterval(() => {
    store.setState((current) => {
      if (current.sleeping) {
        return current;
      }

      return {
        ...current,
        awakeElapsedSec: Math.max(0, Math.floor((Date.now() - current.awakeSinceTs) / 1000)),
      };
    });
  }, 1000);

  await loadInitialState(store);
  ambientRuntime.init();
  fxRuntime?.init();
  glitchRuntime.init();
  speechRuntime.init();
  await voiceRuntime?.init();
  faceBehaviorRuntime.init();
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
      speechRuntime.handleServerMessage(message);
      applyServerMessage(store, message, options.mode);
      proactiveRuntime?.onPresenceChanged();
    },
  });

  faceBehaviorRuntime.attachSender((message) => {
    wsClient.send(message);
  });

  faceRuntime?.attachSender((message) => {
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

function resolveServerLabel(): string {
  if (window.location.port !== '3000') {
    return `${window.location.hostname}:3000`;
  }

  return window.location.host;
}

function selectVisualSlice(state: AppState) {
  return {
    sleeping: state.sleeping,
    audioPlaying: state.audioPlaying,
    currentExpression: state.currentExpression,
    idleVariant: state.idleVariant,
    blinkActive: state.blinkActive,
    subtitleText: state.subtitleText,
    currentSpeechText: state.currentSpeechText,
    liveTranscriptText: state.liveTranscriptText,
    liveTranscriptDraft: state.liveTranscriptDraft,
    currentDonationSignal: state.currentDonationSignal,
    gazeX: state.gazeX,
    gazeY: state.gazeY,
    moodPos: state.moodPos,
    moodNeg: state.moodNeg,
    moodArousal: state.moodArousal,
    fxBaseColorDraft: state.fxBaseColorDraft,
    config: state.config,
  };
}

function selectGlitchSlice(state: AppState) {
  return {
    faceRenderMode: state.config?.faceRenderMode,
    glitchFxEnabled: state.config?.glitchFxEnabled,
    glitchRenderer: state.config?.glitchRenderer,
    glitchFxBaseColor: state.config?.glitchFxBaseColor,
    secondaryGlitchFxBaseColor: state.config?.secondaryGlitchFxBaseColor,
    glitchExpressionProfiles: state.config?.glitchExpressionProfiles,
    renderQuality: state.config?.renderQuality,
    fxBaseColorDraft: state.fxBaseColorDraft,
  };
}

function shallowEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) {
      return false;
    }
  }

  return true;
}
