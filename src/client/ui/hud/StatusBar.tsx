// One line of at-a-glance state across the top. Each chip opens the dock tab
// with the details.

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { AppStore, DockTab, ScreenRecordingPhase } from '../../state/app-state.js';
import { postJson } from '../../transport/http.js';
import type { AppShellControls } from '../app-shell.js';
import { moodWordFor } from '../panels/MindPanel.js';
import { useAppSelector } from '../react-store.js';
import { openDashboardWindow, openFaceWindow, openMiniWindow, toggleFullscreen } from '../window-runtime.js';
import { openDockTab } from './dock-state.js';
import { listenLabel, resolveListenMode } from './listening.js';

export function StatusBar({ store, view, controls }: {
  store: AppStore;
  view: 'face' | 'dashboard';
  controls?: AppShellControls | undefined;
}): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    connected: current.connected,
    connectionLabel: current.connectionLabel,
    micReady: current.micReady,
    micDenied: current.micDenied,
    // Coarse steps: the bar re-renders when the meter visibly moves, not every frame.
    micLevel: Math.round(current.micLevel * 20) / 20,
    recording: current.recording,
    listenState: current.listenState,
    conversationActive: current.conversationActive,
    voiceWakeWordEnabled: current.voiceWakeWordEnabled,
    voiceHandsFreeEnabled: current.voiceHandsFreeEnabled,
    moodWord: moodWordFor({ sleeping: current.sleeping, pos: current.moodPos, neg: current.moodNeg, arousal: current.moodArousal }),
    expression: current.currentExpression,
    lastResponseMs: current.lastResponseMs,
    costUsd: current.stats?.costUsd ?? 0,
    faceCameraActive: current.faceCameraActive,
    faceCount: current.faceLastDetectedCount,
    gpuError: current.logs.find((entry) => entry.level === 'error' && /webgpu/i.test(entry.text))?.text ?? null,
    dualOn: Boolean(current.config?.dualHeadEnabled && current.config.dualHeadMode !== 'off'),
    miniWindowOpen: current.peers.mini,
    faceWindowOpen: current.peers.face,
    studioListener: current.studioLive !== null,
    facePerform: current.facePerform,
    fullscreenActive: current.fullscreenActive,
    screenRecording: current.screenRecording,
    screenRecordingSince: current.screenRecordingSince,
    screenRecordingFile: current.screenRecordingFile,
  }));
  const open = (tab: DockTab) => store.setState((current) => openDockTab(current, tab));
  // The dashboard only knows mic and camera from the face window, or in studio mode the studio listener.
  const deviceKnown = view === 'face' || state.faceWindowOpen || state.studioListener;
  const listenMode = resolveListenMode(state);

  return (
    <header className="status-bar" aria-label="Status">
      <div className="status-chips">
        <Chip id="status-connection" tone={state.connected ? 'ok' : 'bad'} title="Server connection · Settings" onClick={() => open('settings')}>
          <span className="status-dot" />
          {state.connectionLabel}
        </Chip>
        <Chip id="status-mic" tone={!deviceKnown ? 'muted' : state.micDenied ? 'bad' : state.recording ? 'live' : 'plain'} title="Mic and listening · Voice" onClick={() => open('voice')}>
          {deviceKnown && state.micReady ? <MicMeter level={state.micLevel} mode={listenMode} /> : null}
          {!deviceKnown ? 'No face window' : state.micDenied ? 'Mic denied' : !state.micReady ? 'Mic off' : listenLabel(state, listenMode)}
        </Chip>
        <Chip id="status-mood" title={`Mood · face ${state.expression} · Mind`} onClick={() => open('mind')}>
          {state.moodWord}
        </Chip>
        <Chip id="status-latency" title="Last reply took · Stats" onClick={() => open('stats')}>
          {state.lastResponseMs == null ? 'reply –' : `reply ${(state.lastResponseMs / 1000).toFixed(1)} s`}
        </Chip>
        <Chip id="status-cost" title="Session cost · Stats" onClick={() => open('stats')}>
          ${state.costUsd.toFixed(4)}
        </Chip>
        <Chip id="status-camera" tone={!deviceKnown ? 'muted' : state.faceCameraActive ? 'ok' : 'plain'} title="Camera and faces in view · People" onClick={() => open('people')}>
          {!deviceKnown || !state.faceCameraActive
            ? 'cam off'
            : `cam · ${state.faceCount} ${state.faceCount === 1 ? 'face' : 'faces'}`}
        </Chip>
        {state.dualOn ? (
          <Chip id="status-two-heads" title="Two-head mode is on · Settings" onClick={() => open('settings')}>
            two heads{state.miniWindowOpen ? ' · window' : ''}
          </Chip>
        ) : null}
        {state.gpuError ? (
          <Chip id="status-webgpu" tone="bad" title={`${state.gpuError} · Log`} onClick={() => open('log')}>
            WebGPU error
          </Chip>
        ) : null}
      </div>

      <div className="status-actions">
        <RecordControls
          phase={state.screenRecording}
          since={state.screenRecordingSince}
          file={state.screenRecordingFile}
          // Only the face window can start one: Chrome asks that tab to share itself.
          onStart={view === 'face' && controls?.recorder ? () => void controls.recorder?.toggle() : null}
          onStop={view === 'face' ? () => void controls?.recorder?.toggle() : () => controls?.remote?.faceCommand('stopRecording')}
          onReveal={(file) => {
            postJson('/api/recordings/reveal', { file }).catch((error: unknown) => {
              store.appendLog('error', `Show in Finder failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }}
        />
        {view === 'face' ? (
          <>
            <button id="window-perform" type="button" className="status-action" title="Perform mode: hide the HUD (Z)" onClick={() => store.setState((current) => ({ ...current, uiHidden: true }))}>
              Perform
            </button>
            <button id="window-open-mini" type="button" className="status-action" title="Mini Tubs in its own window (O)" onClick={() => openMiniWindow(store, true)}>
              Mini
            </button>
            <button id="window-open-dashboard" type="button" className="status-action" title="Operator dashboard in its own window" onClick={() => openDashboardWindow(store)}>
              Dashboard
            </button>
            <button id="window-fullscreen" type="button" className="status-action" title="Fullscreen (X)" onClick={() => void toggleFullscreen(store)}>
              {state.fullscreenActive ? 'Exit FS' : 'Fullscreen'}
            </button>
          </>
        ) : state.faceWindowOpen ? (
          <button
            id="face-perform-toggle"
            type="button"
            className={`status-action ${state.facePerform ? 'is-on' : ''}`}
            title="Perform mode on the face window"
            onClick={() => controls?.remote?.faceCommand('togglePerform')}
          >
            Face: {state.facePerform ? 'perform' : 'dev view'}
          </button>
        ) : (
          <button id="open-face-window" type="button" className="status-action" onClick={() => openFaceWindow(store)}>
            Open face window
          </button>
        )}
      </div>
    </header>
  );
}

function RecordControls(props: {
  phase: ScreenRecordingPhase;
  since: number | null;
  file: string | null;
  onStart: (() => void) | null;
  onStop: () => void;
  onReveal: (file: string) => void;
}): JSX.Element | null {
  const { phase, since, file } = props;
  if (phase === 'recording') {
    return (
      <button id="recording-toggle" type="button" className="status-action is-rec" title="Stop recording (R)" onClick={props.onStop}>
        <span className="rec-dot" aria-hidden="true" />
        {since == null ? 'REC' : <Elapsed since={since} />}
      </button>
    );
  }
  if (phase === 'starting' || phase === 'saving') {
    return (
      <button id="recording-toggle" type="button" className="status-action" disabled>
        {phase === 'starting' ? 'Rec…' : 'Saving…'}
      </button>
    );
  }
  return (
    <>
      {file ? (
        <button id="recording-show" type="button" className="status-action" title={`Show ${file} in Finder`} onClick={() => props.onReveal(file)}>
          Show video
        </button>
      ) : null}
      {props.onStart ? (
        <button
          id="recording-toggle"
          type="button"
          className="status-action"
          title="Record this tab with Tubs' voice and the mic, saved to ~/Movies/tubs-recordings (R)"
          onClick={props.onStart}
        >
          Rec
        </button>
      ) : null}
    </>
  );
}

function Elapsed({ since }: { since: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</>;
}

function Chip(props: {
  id: string;
  title: string;
  tone?: 'ok' | 'bad' | 'live' | 'muted' | 'plain';
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button id={props.id} type="button" className={`status-chip tone-${props.tone ?? 'plain'}`} title={props.title} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

export function MicMeter({ level, mode }: { level: number; mode: string }): JSX.Element {
  return (
    <span className={`status-meter listen-${mode}`} aria-hidden="true">
      <span style={{ transform: `scaleX(${Math.max(0.04, Math.min(1, level))})` }} />
    </span>
  );
}
