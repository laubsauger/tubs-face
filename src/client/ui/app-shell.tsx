import { useCallback, useRef, useState, useEffect, type CSSProperties, type JSX } from 'react';
import type { EnrollmentCapture } from '../face/enrollment.js';
import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';
import { patchConfig } from '../fx/runtime.js';
import { EnrollmentWizard } from './panels/EnrollmentWizard.js';
import { ChatPanel } from './panels/ChatPanel.js';
import { useAppSelector } from './react-store.js';
import { openMiniWindow, toggleFullscreen } from './window-runtime.js';
import type { FaceCommand } from './window-link.js';
import { StableFaceContainer, VisualShell } from './visual-shell.js';
import { Dock } from './hud/Dock.js';
import { FloatingTranscript } from './hud/FloatingTranscript.js';
import { MiniTile } from './hud/MiniTile.js';
import { StatusBar } from './hud/StatusBar.js';
import { closeFxTab, toggleDockFolded, toggleFxTab } from './hud/dock-state.js';
import { resolveHotkey, type HotkeyAction } from './hud/hotkeys.js';

export interface AppShellProps {
  mode: 'main' | 'dashboard' | 'mini' | 'spectator' | 'studio';
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
    getCameraStream(): MediaStream | null;
    beginEnrollment(): void;
    endEnrollment(): void;
    captureEnrollmentSample(previousEmbeddings: number[][]): Promise<EnrollmentCapture | null>;
    saveEnrollment(name: string, samples: Array<{ embedding: number[]; thumbnail: string }>): Promise<number>;
    refreshLibrary(): Promise<void>;
    renameFace(id: string, name: string): Promise<void>;
    deleteFace(id: string): Promise<void>;
  } | undefined;
  /** Face window: a video of this tab with its sound and the mic (R). */
  recorder?: {
    toggle(): Promise<void>;
  } | undefined;
  /** Dashboard: things only the face window can do (camera, perform mode). */
  remote?: {
    faceCommand(command: FaceCommand): void;
  } | undefined;
}

export function AppShell(props: AppShellProps): JSX.Element {
  if (props.mode === 'spectator') {
    return <SpectatorAppShell store={props.store} />;
  }
  if (props.mode === 'dashboard') {
    return <DashboardAppShell store={props.store} controls={props.controls} />;
  }
  if (props.mode === 'studio') {
    return <StudioAppShell />;
  }
  return props.mode === 'mini'
    ? <MiniAppShell store={props.store} />
    : <MainAppShell store={props.store} controls={props.controls} />;
}

// Mini tile beside the face ('side' placement), as a share of the stage width.
const SIDE_TILE_WIDTH = { small: '26cqw', medium: '33cqw', large: '40cqw' } as const;

/** The face window: status bar, the face stage and the dock, or just the face in perform mode. */
function MainAppShell({ store, controls }: { store: AppStore; controls?: AppShellControls | undefined }): JSX.Element {
  useOperatorHotkeys(store, controls, 'face');
  const state = useAppSelector(store, (current) => ({
    perform: current.uiHidden,
    fullscreenActive: current.fullscreenActive,
    miniSide: Boolean(current.config?.dualHeadEnabled && current.config.dualHeadMode !== 'off')
      && !current.peers.mini
      && current.stage.miniTile
      && current.stage.miniPlacement === 'side',
    miniSize: current.stage.miniSize,
  }));

  return (
    <main className={`shell shell-main ${state.perform ? 'is-perform' : ''} ${state.fullscreenActive ? 'fullscreen-active' : ''}`}>
      <StatusBar store={store} view="face" controls={controls} />
      <div
        className={`stage ${state.miniSide ? 'has-mini-side' : ''}`}
        style={{ '--mini-side-width': SIDE_TILE_WIDTH[state.miniSize] } as CSSProperties}
      >
        <VisualShell store={store} mode="main" />
        <FloatingTranscript store={store} />
        <MiniTile store={store} />
      </div>
      {/* Mounted in perform mode too, just hidden: it holds the camera video. */}
      <Dock store={store} controls={controls} view="face" />
      <EnrollmentWizard store={store} {...(controls?.face ? { controls: controls.face } : {})} />
    </main>
  );
}

/**
 * The operator dashboard for a separate screen: the chat log and the dock, no
 * face. It plays no audio and opens no mic or camera; the face window does.
 */
function DashboardAppShell({ store, controls }: { store: AppStore; controls?: AppShellControls | undefined }): JSX.Element {
  useOperatorHotkeys(store, controls, 'dashboard');
  // Onboarding needs a camera: in studio mode the studio listener's, shown here.
  const studioCamera = useAppSelector(store, (current) => current.studioLive !== null);
  return (
    <main className="shell shell-main shell-dashboard">
      <StatusBar store={store} view="dashboard" controls={controls} />
      <div className="stage dashboard-stage">
        <ChatPanel store={store} />
      </div>
      <Dock store={store} controls={controls} view="dashboard" defaultWidth={560} />
      {studioCamera ? <EnrollmentWizard store={store} {...(controls?.face ? { controls: controls.face } : {})} /> : null}
    </main>
  );
}

/** One keydown listener for every operator shortcut, routed by ui/hud/hotkeys.ts. */
function useOperatorHotkeys(store: AppStore, controls: AppShellControls | undefined, view: 'face' | 'dashboard'): void {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const state = store.getState();
      const action = resolveHotkey({
        key: event.key,
        code: event.code,
        modifier: event.ctrlKey || event.metaKey || event.altKey,
        inTextField: isTextField(event.target),
        view,
        fxOpen: state.fxEditorOpen,
        perform: view === 'face' && state.uiHidden,
        chatInputVisible: state.dockTab === 'chat' && !state.dockFolded && !state.uiHidden,
      });
      if (!action) return;
      // A typed letter must still land in the input it focuses; Enter must not submit.
      const typing = (action === 'focus-chat' || action === 'focus-quick') && event.key !== 'Enter';
      if (!typing) event.preventDefault();
      runHotkey(action, store, controls);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [store, controls, view]);
}

function runHotkey(action: HotkeyAction, store: AppStore, controls: AppShellControls | undefined): void {
  switch (action) {
    case 'fx-toggle':
      store.setState(toggleFxTab);
      return;
    case 'fx-close':
      store.setState(closeFxTab);
      return;
    case 'sleep-toggle':
      void postJson(store.getState().sleeping ? '/wake' : '/sleep', {});
      return;
    case 'mute':
      void patchConfig(store, { muted: !store.getState().config?.muted });
      return;
    case 'camera':
      void controls?.face?.toggleCamera();
      return;
    case 'enroll':
      store.setState((current) => ({ ...current, faceEnrollOpen: true }));
      return;
    case 'debug':
      store.setState((current) => ({ ...current, debugOverlayActive: !current.debugOverlayActive }));
      return;
    case 'transcript-toggle':
      store.setState((current) => ({ ...current, stage: { ...current.stage, transcript: !current.stage.transcript } }));
      return;
    case 'dock-fold':
      store.setState(toggleDockFolded);
      return;
    case 'fullscreen':
      void toggleFullscreen(store);
      return;
    case 'perform-toggle':
      store.setState((current) => ({ ...current, uiHidden: !current.uiHidden }));
      return;
    case 'open-mini':
      openMiniWindow(store, true);
      return;
    case 'record-toggle':
      void controls?.recorder?.toggle();
      return;
    case 'focus-chat':
      document.getElementById('chat-panel-input')?.focus();
      return;
    case 'focus-quick':
      document.getElementById('quick-chat-input')?.focus();
      return;
  }
}

// Fields that take typed text. Shortcuts still work with a toggle or slider focused.
function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'file'].includes(target.type);
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

/**
 * A studio face page: the face alone on black, square. Only the canvas goes
 * into the stream; the status line under it is for whoever looks at the window.
 */
function StudioAppShell(): JSX.Element {
  return (
    <main className="studio-shell">
      <StableFaceContainer id="visual-face" className="visual-face studio-visual-face" />
      <div id="studio-status" className="studio-status" />
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
