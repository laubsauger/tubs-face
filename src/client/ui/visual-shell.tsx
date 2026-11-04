// The face itself and what floats over it: subtitles, live transcript,
// thinking bar and the listening dot.

import { memo, type CSSProperties, type JSX } from 'react';
import type { AppStore } from '../state/app-state.js';
import { useAppSelector } from './react-store.js';
import { listenLabel, resolveListenMode } from './hud/listening.js';

/**
 * Absolutely stable face container — never re-renders.
 * All visual attributes (expression, gaze, render-mode, sleep, blink)
 * are managed imperatively by visual-runtime.ts and glitch/runtime.ts.
 * Keeping this out of React's reconciliation tree prevents the canvas
 * from being disrupted when overlays (transcript, waveform) update.
 */
export const StableFaceContainer = memo(
  function StableFaceContainer({ id, className }: { id: string; className: string }): JSX.Element {
    return (
      <div id={id} className={className} />
    );
  },
  // Never re-render — props don't change and all DOM updates are imperative
  () => true,
);

/** Overlays that sit on top of the face; the stage settings switch them on and off. */
function VisualOverlays({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    sleeping: current.sleeping,
    liveTranscriptText: current.liveTranscriptText,
    liveTranscriptDraft: current.liveTranscriptDraft,
    showSubtitles: current.stage.subtitles,
    showListening: current.stage.listening,
    thinking: current.currentExpression === 'thinking',
  }));

  return (
    <>
      {/* Audience-facing subtitle: big and at the top. Hidden by the wrapper,
          because the speech runtime sets classes on #visual-subtitle itself. */}
      <div className="visual-overlay visual-overlay-top" hidden={!state.showSubtitles}>
        <div id="visual-subtitle" className={`visual-subtitle ${state.sleeping ? 'is-hidden' : ''}`} />
      </div>

      {state.sleeping ? (
        <div className="visual-zzz" aria-hidden="true">
          <span>z</span>
          <span>z</span>
          <span>z</span>
        </div>
      ) : null}

      <div className="visual-overlay visual-overlay-bottom">
        <div className={`visual-thinking-bar ${state.thinking && !state.sleeping ? 'is-active' : ''}`} aria-hidden="true">
          <span />
        </div>
        <div hidden={!state.showListening} className="visual-listening">
          <div
            id="visual-live-transcript"
            className={`visual-live-transcript ${state.liveTranscriptText.trim() ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
          >
            {state.liveTranscriptText}
          </div>
          {state.sleeping ? null : <ListeningDot store={store} />}
        </div>
      </div>
    </>
  );
}

export function VisualShell({ store, mode }: { store: AppStore; mode: 'main' | 'mini' }): JSX.Element {
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

/** A small dot for the audience: its colour says how Tubs listens, its glow follows the mic. */
function ListeningDot({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    micLevel: Math.round(current.micLevel * 20) / 20,
    recording: current.recording,
    listenState: current.listenState,
    conversationActive: current.conversationActive,
    voiceWakeWordEnabled: current.voiceWakeWordEnabled,
    voiceHandsFreeEnabled: current.voiceHandsFreeEnabled,
  }));
  const mode = resolveListenMode(state);
  return (
    <span
      id="visual-listening-dot"
      className={`visual-listening-dot listen-${mode}`}
      title={listenLabel(state, mode)}
      style={{ '--mic-level': Math.max(0, Math.min(1, state.micLevel)) } as CSSProperties}
    />
  );
}
