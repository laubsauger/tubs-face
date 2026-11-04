// The face itself and what floats over it: subtitles, live transcript,
// thinking bar and the listening indicator.

import { memo, type JSX } from 'react';
import type { AppStore } from '../state/app-state.js';
import { useAppSelector } from './react-store.js';

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

/** Overlays that sit on top of the face (subtitle, transcript, waveform) */
function VisualOverlays({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    sleeping: current.sleeping,
    liveTranscriptText: current.liveTranscriptText,
    liveTranscriptDraft: current.liveTranscriptDraft,
    micLevel: current.micLevel,
    recording: current.recording,
    listenState: current.listenState,
    voiceWakeWordEnabled: current.voiceWakeWordEnabled,
    voiceHandsFreeEnabled: current.voiceHandsFreeEnabled,
    conversationActive: current.conversationActive,
    thinking: current.currentExpression === 'thinking',
  }));

  return (
    <>
      {/* Audience-facing subtitle: big and at the top, as on main. */}
      <div className="visual-overlay visual-overlay-top">
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
        <div
          id="visual-live-transcript"
          className={`visual-live-transcript ${state.liveTranscriptText.trim() ? 'is-visible' : ''} ${state.liveTranscriptDraft ? 'is-draft' : ''}`}
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

