import { ConnectionPanel } from './panels/ConnectionPanel.js';
import { VoicePanel } from './panels/VoicePanel.js';
import { FacePanel } from './panels/FacePanel.js';
import { StatsPanel } from './panels/StatsPanel.js';
import { MindPanel } from './panels/MindPanel.js';
import { EventLogPanel } from './panels/EventLogPanel.js';
import { ChatPanel } from './panels/ChatPanel.js';
import { useCallback, useRef, useState, useEffect, type JSX } from 'react';
import type { EnrollmentCapture } from '../face/runtime.js';
import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';
import { patchConfig, toggleFxEditor } from '../fx/runtime.js';
import { FxEditor } from './panels/FxEditor.js';
import { EnrollmentWizard } from './panels/EnrollmentWizard.js';
import { useAppSelector } from './react-store.js';
import { openMiniWindow, toggleFullscreen } from './window-runtime.js';
import { ControlsPanel } from './panels/ControlsPanel.js';
import { ManualPanel } from './panels/ManualPanel.js';
import { StableFaceContainer, VisualShell } from './visual-shell.js';

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
    getCameraStream(): MediaStream | null;
    beginEnrollment(): void;
    endEnrollment(): void;
    captureEnrollmentSample(previousEmbeddings: number[][]): Promise<EnrollmentCapture | null>;
    saveEnrollment(name: string, samples: Array<{ embedding: number[]; thumbnail: string }>): Promise<number>;
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
          store.setState((s) => ({ ...s, faceEnrollOpen: true }));
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
            <MindPanel store={store} />
            <StatsPanel store={store} />
            <ControlsPanel store={store} {...(controls ? { controls } : {})} />
            <ManualPanel store={store} />
            <EventLogPanel store={store} />
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
      <EnrollmentWizard store={store} {...(controls?.face ? { controls: controls.face } : {})} />

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
