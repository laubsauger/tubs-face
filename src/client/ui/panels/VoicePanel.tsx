import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import type { AppShellControls } from '../app-shell.js';
import { toggleFullscreen } from '../window-runtime.js';

export function VoicePanel({
  store,
  controls,
}: {
  store: AppStore;
  controls?: AppShellControls | undefined;
}): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.voice),
    micReady: current.micReady,
    micDenied: current.micDenied,
    micLevel: current.micLevel,
    recording: current.recording,
    listenState: current.listenState,
    voiceWakeWordEnabled: current.voiceWakeWordEnabled,
    voiceHandsFreeEnabled: current.voiceHandsFreeEnabled,
    audioPlaying: current.audioPlaying,
    voiceLastTranscript: current.voiceLastTranscript,
    faceCameraActive: current.faceCameraActive,
    fullscreenActive: current.fullscreenActive,
    vadModel: current.config?.vadModel ?? 'rms',
    faceDetectionDelayMs: (current.config as any)?.faceDetectionDelayMs ?? 'auto',
  }));

  const pending = !state.recording && (state.listenState === 'Uploading...' || state.listenState === 'Thinking...');

  return (
    <article className={`bg-slate-900/90 backdrop-blur-xl border border-slate-700 shadow-2xl rounded-2xl overflow-hidden transition-all flex flex-col ${state.collapsed ? 'h-11' : ''}`}>
      <PanelHeader store={store} panelKey="voice" title="Input Status" meta={state.recording ? 'REC' : state.listenState} />
      
      <div className={`p-4 flex flex-col gap-4 overflow-y-auto ${state.collapsed ? 'hidden' : ''}`}>
        
        {/* Mic Meter block */}
        <div className="flex flex-col gap-2 p-3 bg-slate-950/50 rounded-xl border border-slate-800">
          <div className="flex justify-between text-xs font-mono">
            <span className={state.micReady ? 'text-emerald-400' : 'text-slate-500'}>
              {state.micReady ? 'MIC ACTIVE' : state.micDenied ? 'MIC DENIED' : 'MIC PENDING'}
            </span>
            <span className="text-cyan-400 font-bold">{Math.round(state.micLevel * 100)}%</span>
          </div>
          <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
            <div 
              className={`h-full ${state.recording ? 'bg-red-500' : 'bg-emerald-500'} transition-transform duration-75 origin-left`} 
              style={{ transform: `scaleX(${Math.max(0.02, state.micLevel)})` }} 
            />
          </div>
          <div className="text-[10px] text-slate-500 mt-1 uppercase tracking-wider">
            VAD Model: {state.vadModel}
          </div>
        </div>

        {/* Toggles Grid */}
        <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
          <button
            className={`py-2 px-3 rounded-lg border transition-all ${state.faceCameraActive ? 'bg-cyan-900/40 border-cyan-500/50 text-cyan-300' : 'bg-slate-800 border-slate-700 hover:bg-slate-700 text-slate-300'}`}
            onClick={() => controls?.face?.toggleCamera()}
          >
            Camera {state.faceCameraActive ? 'On' : 'Off'}
          </button>
          
          <button
            className={`py-2 px-3 rounded-lg border transition-all ${state.fullscreenActive ? 'bg-purple-900/40 border-purple-500/50 text-purple-300' : 'bg-slate-800 border-slate-700 hover:bg-slate-700 text-slate-300'}`}
            onClick={() => toggleFullscreen(store)}
          >
            Fullscreen {state.fullscreenActive ? 'On' : 'Off'}
          </button>
          
          <label className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border transition-all cursor-pointer ${state.voiceHandsFreeEnabled ? 'bg-emerald-900/40 border-emerald-500/50 text-emerald-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}>
            <input
              type="checkbox"
              className="sr-only"
              checked={state.voiceHandsFreeEnabled}
              onChange={(e) => {
                store.setState(s => ({ ...s, voiceHandsFreeEnabled: e.target.checked }));
              }}
            />
            Always Listen
          </label>

          <label className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg border transition-all cursor-pointer ${state.voiceWakeWordEnabled ? 'bg-blue-900/40 border-blue-500/50 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}>
            <input
              type="checkbox"
              className="sr-only"
              checked={state.voiceWakeWordEnabled}
              onChange={(e) => {
                store.setState(s => ({ ...s, voiceWakeWordEnabled: e.target.checked }));
              }}
            />
            Wake Word
          </label>
        </div>

        {/* Delay Slider */}
        {state.faceCameraActive && (
          <div className="flex flex-col gap-2 p-3 bg-slate-950/50 rounded-xl border border-slate-800">
            <div className="flex justify-between text-xs font-mono text-slate-400">
              <span>Detection Delay</span>
              <span className="text-cyan-400">{state.faceDetectionDelayMs === 0 ? 'Auto' : `${state.faceDetectionDelayMs}ms`}</span>
            </div>
            <input 
              type="range" 
              min="0" max="5000" step="100" 
              className="w-full accent-cyan-500 bg-slate-800"
              value={state.faceDetectionDelayMs === 'auto' ? 0 : state.faceDetectionDelayMs}
              onChange={(e) => {
                const val = Number(e.target.value);
                store.setState(s => ({ 
                  ...s, 
                  config: s.config ? { ...s.config, faceDetectionDelayMs: val === 0 ? 'auto' : val } : null 
                }));
              }}
            />
          </div>
        )}

        {/* Live Action PTT */}
        <button
          className={`mt-2 py-3 rounded-xl border font-bold uppercase tracking-widest transition-all ${state.recording ? 'bg-red-500 border-red-400 text-white shadow-[0_0_20px_rgba(239,68,68,0.5)]' : pending ? 'bg-amber-500 text-white animate-pulse' : 'bg-slate-800 border-slate-700 hover:bg-slate-700 text-slate-300'}`}
          onPointerDown={async (e) => { e.preventDefault(); await controls?.voice?.startManualRecording(); }}
          onPointerUp={(e) => { e.preventDefault(); controls?.voice?.stopManualRecording(); }}
          onPointerLeave={() => controls?.voice?.stopManualRecording()}
        >
          {state.recording ? 'Recording' : pending ? state.listenState : 'Push To Talk'}
        </button>

        <p className="text-[11px] text-slate-500 italic mt-1 leading-tight text-center">
          {state.voiceLastTranscript || 'Speak naturally or use spacebar to push-to-talk to send a turn.'}
        </p>

      </div>
    </article>
  );
}
