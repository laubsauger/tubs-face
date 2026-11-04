// One line of at-a-glance state across the top. Each chip opens the dock tab
// with the details.

import type { JSX, ReactNode } from 'react';
import type { AppStore, DockTab } from '../../state/app-state.js';
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
    facePerform: current.facePerform,
    fullscreenActive: current.fullscreenActive,
  }));
  const open = (tab: DockTab) => store.setState((current) => openDockTab(current, tab));
  // The dashboard only knows mic and camera from the face window.
  const deviceKnown = view === 'face' || state.faceWindowOpen;
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

function MicMeter({ level, mode }: { level: number; mode: string }): JSX.Element {
  return (
    <span className={`status-meter listen-${mode}`} aria-hidden="true">
      <span style={{ transform: `scaleX(${Math.max(0.04, Math.min(1, level))})` }} />
    </span>
  );
}
