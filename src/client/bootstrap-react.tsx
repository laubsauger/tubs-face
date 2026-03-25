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
  mode: 'main' | 'mini' | 'spectator';
  root: HTMLElement;
  /** Which face to follow in spectator mode. Defaults to 'main'. */
  actor?: 'main' | 'small';
}

export interface BootstrapHandle {
  dispose(): void;
}

export async function bootstrapClient(options: BootstrapOptions): Promise<BootstrapHandle> {
  const store = createAppStore(resolveServerLabel());
  const isController = options.mode === 'main';
  const isSpectator = options.mode === 'spectator';
  // Spectator processes server messages like 'main' (subtitles, gaze, expressions) but
  // uses 'mini' for speech runtime (don't generate own TTS — only play broadcast audio_chunks).
  const messageMode: 'main' | 'mini' = options.mode === 'mini' ? 'mini' : 'main';
  // Speech runtime: spectator uses 'mini' to skip speak/speak_chunk TTS generation.
  // Audio still plays via audio_chunk handler which has no mode check.
  const speechMode: 'main' | 'mini' = isSpectator ? 'mini' : messageMode;
  // Which actor the spectator follows. Defaults to 'main'. In dual-head, each
  // spectator URL targets one face (?actor=main or ?actor=small).
  const targetActor: 'main' | 'small' | undefined = isSpectator
    ? (options.actor ?? 'main')
    : undefined;

  const ambientRuntime = isSpectator ? null : createAmbientRuntime(store, messageMode);
  const emotionRuntime = isController ? createEmotionRuntime(store) : null;
  const fxRuntime = isController ? createFxRuntime(store) : null;
  const glitchRuntime = createGlitchRuntime(store, messageMode);
  const proactiveRuntime = isController ? createProactiveRuntime(store) : null;
  const speechRuntime = createSpeechRuntime(store, speechMode);
  const visualRuntime = createVisualRuntime(store, messageMode);
  const voiceRuntime = isController ? createVoiceRuntime(store) : null;
  const faceBehaviorRuntime = createFaceBehaviorRuntime(store, messageMode);
  const faceRuntime = isController ? createFaceShellRuntime(store) : null;
  const windowRuntime = createWindowRuntime(store, messageMode);

  const controls: AppShellControls | undefined = isController
    ? {
      ambient: {
        toggleEnabled: () => ambientRuntime!.toggleEnabled(),
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
  ambientRuntime?.init();
  fxRuntime?.init();
  glitchRuntime.init();
  speechRuntime.init();
  await voiceRuntime?.init();
  faceBehaviorRuntime.init();
  faceRuntime?.init();
  windowRuntime.init();
  emotionRuntime?.init();

  const wsClient = createManagedWsClient({
    ...(isSpectator ? { role: 'spectator' as const } : {}),
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
      applyServerMessage(store, message, messageMode, targetActor);
      speechRuntime.handleServerMessage(message, targetActor);
      proactiveRuntime?.onPresenceChanged();
    },
  });

  if (!isSpectator) {
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

    window.addEventListener('tubs:request-interrupt', ((event: Event) => {
      const detail = (event as CustomEvent<{ turnId?: string | null }>).detail;
      wsClient.send({
        type: 'interrupt',
        ...(detail?.turnId ? { turnId: detail.turnId } : {}),
      });
    }) as EventListener);

    window.addEventListener('tubs:tts-request', ((event: Event) => {
      const detail = (event as CustomEvent<{ text: string; voice?: string; turnId?: string }>).detail;
      if (!detail?.text) return;
      wsClient.send({
        type: 'tts_request',
        text: detail.text,
        ...(detail.voice ? { voice: detail.voice } : {}),
        ...(detail.turnId ? { turnId: detail.turnId } : {}),
      });
    }) as EventListener);

    proactiveRuntime?.init((message) => {
      wsClient.send(message);
    });
  }

  // Spectator tap-to-unlock: pre-create and resume the streaming AudioContext
  if (isSpectator) {
    window.addEventListener('tubs:unlock-audio', () => {
      speechRuntime.unlockAudio();
    });
  }

  wsClient.connect();

  return {
    dispose() {
      wsClient.disconnect();
      speechRuntime.dispose();
      ambientRuntime?.dispose?.();
    },
  };
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
