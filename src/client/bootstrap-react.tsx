import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createAmbientRuntime } from './audio/ambient-runtime.js';
import { createScreenRecorder } from './audio/screen-recorder.js';
import { createSpeechRuntime } from './audio/speech-runtime.js';
import { createVoiceRuntime } from './audio/voice-runtime.js';
import { createStudioRuntime, type StudioRuntime } from './studio/runtime.js';
import { isWsStudioServerMessage } from '../shared/guards/index.js';
import { createEmotionRuntime } from './behavior/emotion-runtime.js';
import { createProactiveRuntime } from './behavior/proactive-runtime.js';
import { createSleepRuntime } from './behavior/sleep-runtime.js';
import { createFaceBehaviorRuntime } from './face/behavior-runtime.js';
import { createFaceShellRuntime } from './face/runtime.js';
import { createFxRuntime } from './fx/runtime.js';
import { createGlitchRuntime } from './glitch/runtime.js';
import { applyServerMessage } from './handlers/messages.js';
import { DASHBOARD_UI_PREFS_STORAGE_KEY, UI_PREFS_STORAGE_KEY, createAppStore, persistUiPrefs, syncStagePrefs, type AppState, type AppStore } from './state/app-state.js';
import { fetchJson } from './transport/http.js';
import { createManagedWsClient } from './transport/ws-client.js';
import { createVisualRuntime } from './ui/visual-runtime.js';
import { createWindowRuntime } from './ui/window-runtime.js';
import { createWindowLink, type FaceCommand, type WindowLink } from './ui/window-link.js';
import { applyFxEditorVisibility, dockTabsFor, isFxEditorVisible } from './ui/hud/dock-state.js';
import { loadFaceLibraryIntoStore } from './face/library.js';
import { removeFaceEntry, renameFaceEntry } from './face/library-actions.js';
import { AppShell, type AppShellControls } from './ui/app-shell.js';
import type { ConfigResponse, HealthResponse, StatsResponse } from '../shared/contracts/http.js';
import type { WsServerMessage } from '../shared/contracts/ws.js';

export interface BootstrapOptions {
  /**
   * 'dashboard' is the operator HUD without a face, for its own screen.
   * 'studio' is one head published to the studio site node (studio-face.html).
   */
  mode: 'main' | 'dashboard' | 'mini' | 'spectator' | 'studio';
  root: HTMLElement;
  /** Which face to follow in spectator mode, or to show in studio mode. Defaults to 'main'. */
  actor?: 'main' | 'small';
  /** Mini only: running as the tile inside the face window, not as its own window. */
  embedded?: boolean;
  /** Studio only: the stream's size in pixels (square), and whether to also play the voice here. */
  studio?: { size: number; monitor: boolean };
}

export interface BootstrapHandle {
  dispose(): void;
}

export async function bootstrapClient(options: BootstrapOptions): Promise<BootstrapHandle> {
  // The face window owns the mic, camera and speakers. The dashboard shows the
  // same HUD on another screen but must never play speech or open a device:
  // the server sends audio to every client, so a second player doubles it.
  const isController = options.mode === 'main';
  const isDashboard = options.mode === 'dashboard';
  const isOperator = isController || isDashboard;
  const isSpectator = options.mode === 'spectator';
  // A studio page shows one head. The main one also does the face window's
  // listening job (mic, sleep, proactive lines): see studio/runtime.ts.
  const isStudio = options.mode === 'studio';
  const studioActor: 'main' | 'small' | undefined = isStudio ? (options.actor ?? 'main') : undefined;
  const isStudioListener = studioActor === 'main';
  const store = createAppStore(isController ? UI_PREFS_STORAGE_KEY : isDashboard ? DASHBOARD_UI_PREFS_STORAGE_KEY : undefined);
  // Spectator processes server messages like 'main' (subtitles, gaze, expressions) but
  // uses 'mini' for speech runtime (don't generate own TTS — only play broadcast audio_chunks).
  const messageMode: 'main' | 'mini' = options.mode === 'mini' || studioActor === 'small' ? 'mini' : 'main';
  // Speech runtime: spectator uses 'mini' to skip speak/speak_chunk TTS generation.
  // Audio still plays via audio_chunk handler which has no mode check.
  const speechMode: 'main' | 'mini' = isSpectator ? 'mini' : messageMode;
  // Which actor the spectator follows. Defaults to 'main'. In dual-head, each
  // spectator URL targets one face (?actor=main or ?actor=small).
  const targetActor: 'main' | 'small' | undefined = isSpectator
    ? (options.actor ?? 'main')
    : undefined;

  const hasFace = !isDashboard;
  // Studio pages leave the room's sound to the studio: no ambient bed in the stream.
  const ambientRuntime = isSpectator || isDashboard || isStudio ? null : createAmbientRuntime(store, messageMode);
  const emotionRuntime = isController || isStudioListener ? createEmotionRuntime(store) : null;
  const fxRuntime = isOperator ? createFxRuntime(store) : null;
  const glitchRuntime = hasFace
    ? createGlitchRuntime(store, messageMode, isStudio ? { studioCanvasPx: options.studio?.size ?? 1024 } : {})
    : null;
  let lastImpulseTurnId: string | undefined;
  const proactiveRuntime = isController || isStudioListener ? createProactiveRuntime(store) : null;
  const sleepRuntime = isController || isStudioListener ? createSleepRuntime(store) : null;
  const speechRuntime = hasFace ? createSpeechRuntime(store, speechMode) : null;
  const visualRuntime = hasFace ? createVisualRuntime(store, messageMode) : null;
  let studioRuntime: StudioRuntime | null = null;
  const voiceRuntime = isController
    ? createVoiceRuntime(store)
    : isStudioListener
      ? createVoiceRuntime(store, {
        // The source comes with the studio settings; the voice plays in the
        // stream, out of reach of the browser's echo cancellation.
        deferMic: true,
        echoGuard: true,
        onMicStatus: (status) => studioRuntime?.noteMic(status),
      })
      : null;
  const faceBehaviorRuntime = hasFace ? createFaceBehaviorRuntime(store, messageMode) : null;
  // The studio listener takes the studio camera's pictures (docs/vision.md), without a dock to show them.
  const faceRuntime = isController
    ? createFaceShellRuntime(store)
    : isStudioListener ? createFaceShellRuntime(store, { headless: true }) : null;
  const screenRecorder = isController ? createScreenRecorder(store) : null;
  // The mini tile follows the face window it sits in, not the fullscreen sync.
  const windowRuntime = isDashboard || options.embedded || isStudio ? null : createWindowRuntime(store, messageMode);
  if (isStudio && studioActor && speechRuntime && faceBehaviorRuntime && glitchRuntime) {
    studioRuntime = createStudioRuntime({
      store,
      actor: studioActor,
      root: options.root,
      speech: speechRuntime,
      faceBehavior: faceBehaviorRuntime,
      glitch: glitchRuntime,
      canvasPx: options.studio?.size ?? 1024,
      voice: voiceRuntime,
      face: faceRuntime,
      monitor: options.studio?.monitor ?? false,
    });
  }
  const windowLink: WindowLink | null = isController
    ? createWindowLink(store, 'face', (command) => runFaceCommand(command))
    : isDashboard
      ? createWindowLink(store, 'dashboard')
      : options.mode === 'mini' && !options.embedded
        ? createWindowLink(store, 'mini')
        : null;
  let unlockAudioOnGesture: ((event: Event) => void) | null = null;
  let spectatorUnlockHandler: (() => void) | null = null;
  let headSpeechStateHandler: ((event: Event) => void) | null = null;
  let requestInterruptHandler: ((event: Event) => void) | null = null;
  let ttsRequestHandler: ((event: Event) => void) | null = null;
  let faceEnrolledHandler: ((event: Event) => void) | null = null;

  const controls: AppShellControls | undefined = isController
    ? {
      ambient: {
        toggleEnabled: () => ambientRuntime!.toggleEnabled(),
      },
      ...(screenRecorder ? { recorder: { toggle: () => screenRecorder.toggle() } } : {}),
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
          getCameraStream: () => faceRuntime.getCameraStream(),
          beginEnrollment: () => faceRuntime.beginEnrollment(),
          endEnrollment: () => faceRuntime.endEnrollment(),
          captureEnrollmentSample: (previous) => faceRuntime.captureEnrollmentSample(previous),
          saveEnrollment: (name, samples) => faceRuntime.saveEnrollment(name, samples),
          refreshLibrary: () => faceRuntime.refreshLibrary(),
          renameFace: (id: string, name: string) => faceRuntime.renameFace(id, name),
          deleteFace: (id: string) => faceRuntime.deleteFace(id),
        },
      } : {}),
    }
    : isDashboard
      ? createDashboardControls(store, (command) => windowLink?.command(command))
      : undefined;

  // The dashboard asks; the face window, which has the devices, does.
  function runFaceCommand(command: FaceCommand): void {
    switch (command) {
      case 'toggleCamera':
        void controls?.face?.toggleCamera();
        return;
      case 'toggleAmbient':
        void controls?.ambient?.toggleEnabled();
        return;
      case 'togglePerform':
        store.setState((current) => ({ ...current, uiHidden: !current.uiHidden }));
        return;
      case 'refreshFaces':
        void controls?.face?.refreshLibrary();
        return;
      case 'pttStart':
        void controls?.voice?.startManualRecording();
        return;
      case 'pttStop':
        controls?.voice?.stopManualRecording();
        return;
      case 'stopRecording':
        screenRecorder?.stop();
        return;
    }
  }

  const reactRoot = createRoot(options.root);
  // Commit synchronously: the runtimes below look up React's DOM nodes
  // (#visual-subtitle, #visual-face, .visual-shell) in the next frame. With a
  // concurrent render the commit sometimes landed after that frame, and those
  // runtimes kept a null node for the whole session (no subtitles, no gaze).
  flushSync(() => {
    reactRoot.render(
      <AppShell
        mode={options.mode}
        store={store}
        {...(controls ? { controls } : {})}
      />,
    );
  });

  const bindInteractiveRuntimes = () => {
    speechRuntime?.bind(options.root);
    faceBehaviorRuntime?.bind(options.root);
    faceRuntime?.bind(options.root);
  };
  window.requestAnimationFrame(() => {
    bindInteractiveRuntimes();
    visualRuntime?.bind(options.root);
    glitchRuntime?.bind(options.root);
  });

  store.subscribeSelector(selectVisualSlice, () => {
    visualRuntime?.bind(options.root);
  }, {
    equalityFn: shallowEqual,
    fireImmediately: false,
  });

  // Gaze changes every animation frame; only the two gaze CSS variables follow it.
  store.subscribeSelector((state: AppState) => ({ x: state.gazeX, y: state.gazeY }), () => {
    visualRuntime?.syncGaze();
  }, {
    equalityFn: shallowEqual,
    fireImmediately: false,
  });

  store.subscribeSelector(selectGlitchSlice, () => {
    glitchRuntime?.bind(options.root);
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

  if (isOperator) {
    persistUiPrefs(store, isController ? UI_PREFS_STORAGE_KEY : DASHBOARD_UI_PREFS_STORAGE_KEY);
    syncStagePrefs(store);
    // The FX editor is a dock tab: it is live exactly while that tab is on screen.
    store.subscribeSelector(isFxEditorVisible, () => store.setState(applyFxEditorVisibility), { fireImmediately: true });
  }
  if (isDashboard) {
    const tabs = dockTabsFor('dashboard');
    if (!tabs.includes(store.getState().dockTab)) {
      store.setState((current) => ({ ...current, dockTab: tabs[0] ?? 'settings' }));
    }
  }
  if (isController) {
    // A dashboard on another screen takes over the operator's job, so the face
    // screen goes clean. Z brings the HUD back.
    store.subscribeSelector((state: AppState) => state.peers.dashboard, (dashboardOpen) => {
      if (dashboardOpen) store.setState((current) => ({ ...current, uiHidden: true }));
    });
  }

  store.appendLog('info', `${options.mode} client booting`);

  const awakeTimer = window.setInterval(() => {
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
  glitchRuntime?.init();
  speechRuntime?.init();
  // Not awaited: getUserMedia can wait on a permission prompt forever, and the
  // face must still connect and run on an unattended display.
  void voiceRuntime?.init().catch((error: unknown) => {
    store.appendLog('error', `Voice init failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  faceBehaviorRuntime?.init();
  // A studio page starts its face detector only once it has a camera (studio/runtime.ts).
  if (!isStudio) faceRuntime?.init();
  windowRuntime?.init();
  if (isDashboard) {
    void loadFaceLibraryIntoStore(store);
  }
  emotionRuntime?.init();
  sleepRuntime?.init();

  const wsClient = createManagedWsClient({
    // The server takes nothing but pings from a spectator, so the dashboard
    // cannot send face motion, speech state or proactive turns by mistake.
    ...(isSpectator || isDashboard ? { role: 'spectator' as const } : {}),
    ...(studioActor ? { studio: studioActor } : {}),
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
      // Only studio pages act on studio messages. The operator face hears
      // studio_config only while studio mode is on, or after it was switched:
      // then the studio listener has the mic and this face lets go of it.
      if (isWsStudioServerMessage(message)) {
        studioRuntime?.handle(message);
        if (isController && message.type === 'studio_config') {
          void voiceRuntime?.setMicSource(message.enabled ? { kind: 'off' } : { kind: 'local' });
          // The studio listener owns the pictures too; two cameras would greet everyone twice.
          if (message.enabled && store.getState().faceCameraActive) faceRuntime?.stopCamera();
        }
        return;
      }
      if (message.type === 'incoming') {
        proactiveRuntime?.onUserTurn();
      } else if (message.type === 'speak' || message.type === 'speak_end' || message.type === 'turn_script') {
        proactiveRuntime?.onActivity();
      }
      if (message.type === 'speak' && message.emotion?.impulse) {
        emotionRuntime?.pushImpulse(message.emotion.impulse, 'spoken');
      }
      // Streamed replies carry their emotion on every chunk; count it once per turn.
      if (message.type === 'audio_chunk' && message.emotion?.impulse && message.turnId !== lastImpulseTurnId) {
        lastImpulseTurnId = message.turnId;
        emotionRuntime?.pushImpulse(message.emotion.impulse, 'spoken');
      }
      // Only the main face holds the camera snapshots.
      if (message.type === 'enroll_request') {
        void faceRuntime?.autoEnroll(message.personId, message.name);
      }
      // Someone was removed from the face library: stop recognising them.
      if (message.type === 'faces_changed') {
        void faceRuntime?.refreshLibrary();
        if (isDashboard) void loadFaceLibraryIntoStore(store);
      }
      if (message.type === 'thinking') {
        emotionRuntime?.pushImpulse({ arousal: 0.52 }, 'system');
      }
      sleepRuntime?.onServerMessage(message);
      applyServerMessage(store, message, messageMode, targetActor);
      speechRuntime?.handleServerMessage(message, targetActor);
    },
  });

  if (speechRuntime && !isSpectator) {
    unlockAudioOnGesture = () => {
      speechRuntime.unlockAudio();
    };
    window.addEventListener('pointerdown', unlockAudioOnGesture, true);
    window.addEventListener('keydown', unlockAudioOnGesture, true);

    faceBehaviorRuntime?.attachSender((message) => {
      wsClient.send(message);
    });

    faceRuntime?.attachSender((message) => {
      wsClient.send(message);
    });

    headSpeechStateHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ actor?: 'main' | 'small'; state?: 'start' | 'end'; turnId?: string | null; ts?: number; durationMs?: number }>).detail;
      wsClient.send({
        type: 'head_speech_state',
        actor: detail?.actor === 'small' ? 'small' : 'main',
        state: detail?.state === 'end' ? 'end' : 'start',
        ...(detail?.turnId !== undefined ? { turnId: detail.turnId } : {}),
        ts: detail?.ts ?? Date.now(),
        ...(detail?.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
      });
    };
    window.addEventListener('tubs:head-speech-state', headSpeechStateHandler as EventListener);

    requestInterruptHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ turnId?: string | null }>).detail;
      wsClient.send({
        type: 'interrupt',
        ...(detail?.turnId ? { turnId: detail.turnId } : {}),
      });
    };
    window.addEventListener('tubs:request-interrupt', requestInterruptHandler as EventListener);

    ttsRequestHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string; voice?: string; turnId?: string }>).detail;
      if (!detail?.text) return;
      wsClient.send({
        type: 'tts_request',
        text: detail.text,
        ...(detail.voice ? { voice: detail.voice } : {}),
        ...(detail.turnId ? { turnId: detail.turnId } : {}),
      });
    };
    window.addEventListener('tubs:tts-request', ttsRequestHandler as EventListener);

    // Right after onboarding, Tubs greets the new face by name.
    faceEnrolledHandler = (event: Event) => {
      const name = (event as CustomEvent<{ name?: string }>).detail?.name?.trim();
      if (!name) return;
      wsClient.send({
        type: 'proactive',
        context: `You just learned ${name}'s face and will recognize them from now on. Greet ${name} by name, smug about your new trick.`,
        faces: [name],
      });
    };
    window.addEventListener('tubs:face-enrolled', faceEnrolledHandler);

    proactiveRuntime?.init((message) => {
      wsClient.send(message);
    });
  }

  studioRuntime?.init((message) => {
    wsClient.send(message);
  });

  // Spectator tap-to-unlock: pre-create and resume the streaming AudioContext
  if (speechRuntime && isSpectator) {
    spectatorUnlockHandler = () => {
      speechRuntime.unlockAudio();
    };
    window.addEventListener('tubs:unlock-audio', spectatorUnlockHandler);
  }

  wsClient.connect();

  return {
    dispose() {
      window.clearInterval(awakeTimer);
      if (unlockAudioOnGesture) {
        window.removeEventListener('pointerdown', unlockAudioOnGesture, true);
        window.removeEventListener('keydown', unlockAudioOnGesture, true);
      }
      if (spectatorUnlockHandler) {
        window.removeEventListener('tubs:unlock-audio', spectatorUnlockHandler);
      }
      if (headSpeechStateHandler) {
        window.removeEventListener('tubs:head-speech-state', headSpeechStateHandler as EventListener);
      }
      if (requestInterruptHandler) {
        window.removeEventListener('tubs:request-interrupt', requestInterruptHandler as EventListener);
      }
      if (ttsRequestHandler) {
        window.removeEventListener('tubs:tts-request', ttsRequestHandler as EventListener);
      }
      if (faceEnrolledHandler) {
        window.removeEventListener('tubs:face-enrolled', faceEnrolledHandler);
      }
      wsClient.disconnect();
      studioRuntime?.dispose();
      windowLink?.dispose();
      screenRecorder?.dispose();
      sleepRuntime?.dispose();
      speechRuntime?.dispose();
      ambientRuntime?.dispose?.();
    },
  };
}

/**
 * The dashboard's controls: camera, mic and ambient sound go to the face
 * window. Library edits happen here and the face window reloads its library,
 * which it matches visitors against. Detection and onboarding need the camera,
 * so they stay on the face window.
 */
function createDashboardControls(store: AppStore, faceCommand: (command: FaceCommand) => void): AppShellControls {
  const refreshHere = (appStore: AppStore) => loadFaceLibraryIntoStore(appStore);
  const refreshEverywhere = async (appStore: AppStore) => {
    await refreshHere(appStore);
    faceCommand('refreshFaces');
  };
  const faceWindowOnly = async (): Promise<never> => {
    throw new Error('Only the face window has the camera');
  };
  return {
    ambient: { toggleEnabled: async () => faceCommand('toggleAmbient') },
    voice: {
      enableMic: async () => {},
      startManualRecording: async () => faceCommand('pttStart'),
      stopManualRecording: () => faceCommand('pttStop'),
    },
    face: {
      toggleCamera: async () => faceCommand('toggleCamera'),
      detectFile: async () => store.appendLog('error', 'Detect from a photo on the face window'),
      saveDetectedFace: async () => store.appendLog('error', 'Save faces on the face window'),
      getCameraStream: () => null,
      beginEnrollment: () => {},
      endEnrollment: () => {},
      captureEnrollmentSample: faceWindowOnly,
      saveEnrollment: faceWindowOnly,
      refreshLibrary: () => refreshEverywhere(store),
      renameFace: (id, name) => renameFaceEntry(store, id, name, refreshEverywhere),
      deleteFace: (id) => removeFaceEntry(store, id, refreshEverywhere),
    },
    remote: { faceCommand },
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


function selectVisualSlice(state: AppState) {
  return {
    sleeping: state.sleeping,
    audioPlaying: state.audioPlaying,
    currentExpression: state.currentExpression,
    blinkActive: state.blinkActive,
    fxBaseColorDraft: state.fxBaseColorDraft,
    config: state.config,
  };
}

function selectGlitchSlice(state: AppState) {
  // Any config field can change the glitch face (pixel grid, shapes, effects);
  // the glitch runtime diffs what it actually uses.
  return {
    config: state.config,
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
