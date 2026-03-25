import { useRef, type JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import type { AppShellControls } from '../app-shell.js';

export function FacePanel({
  store,
  controls,
}: {
  store: AppStore;
  controls?: AppShellControls['face'];
}): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.face),
    debugOverlayActive: current.debugOverlayActive,
    faceWorkerReady: current.faceWorkerReady,
    faceWorkerBusy: current.faceWorkerBusy,
    faceCameraActive: current.faceCameraActive,
    faceStatus: current.faceStatus,
    faceLastDetectedCount: current.faceLastDetectedCount,
    faceLastInferenceMs: current.faceLastInferenceMs,
    faceLastEmbeddingsExtracted: current.faceLastEmbeddingsExtracted,
    faceLastEmbeddingsReused: current.faceLastEmbeddingsReused,
    faceLibraryEmbeddings: current.faceLibraryEmbeddings,
    faceLibraryPeople: current.faceLibraryPeople,
    faceDraftName: current.faceDraftName,
    faceLastFaces: current.faceLastFaces,
  }));
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <article id="face-panel-card" className={`panel-surface panel-surface-face face-panel-card relative transition-all w-full ${state.collapsed ? 'is-collapsed h-11' : ''}`}>
      <PanelHeader store={store} panelKey="face" title="Face Worker" meta="" />
      
      {state.debugOverlayActive && (
        <div className="absolute bottom-full mb-4 right-0 w-80 bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 p-5 rounded-2xl shadow-2xl z-50 pointer-events-auto flex flex-col gap-4 text-left">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-2">Debug Interface</h3>
          <dl className="grid grid-cols-[100px_1fr] gap-2 text-xs font-mono text-slate-400">
            <dt className="text-slate-500">Status</dt><dd id="face-status-value" className="text-emerald-400 font-bold">{state.faceStatus}</dd>
            <dt className="text-slate-500">Inference</dt><dd id="face-inference-value">{state.faceLastInferenceMs == null ? 'n/a' : `${state.faceLastInferenceMs} ms`}</dd>
            <dt className="text-slate-500">Embeddings</dt><dd id="face-embeddings-value">{state.faceLastEmbeddingsExtracted} new / {state.faceLastEmbeddingsReused} cached</dd>
            <dt className="text-slate-500">Library</dt><dd id="face-library-value">{state.faceLibraryEmbeddings} embs / {state.faceLibraryPeople} ppl</dd>
          </dl>
          <div className="flex flex-col gap-2 mt-2">
            <button className="button w-full justify-center" disabled={state.faceWorkerBusy} onClick={() => uploadInputRef.current?.click()}>
              {state.faceWorkerBusy ? 'Processing...' : 'Detect Frame'}
            </button>
            <button className="button button-secondary w-full justify-center" onClick={() => controls?.refreshLibrary()}>
              Reload Library
            </button>
          </div>
          
          <div className="mt-2">
            <h4 className="text-xs font-bold text-slate-400 mb-2">Matches</h4>
            <ul id="face-results-list" className="flex flex-col gap-1">
              {state.faceLastFaces.length === 0
                ? <li className="text-xs text-slate-500">No detections yet.</li>
                : state.faceLastFaces.map((face, index) => (
                  <li key={`${face.name ?? face.match?.name ?? 'face'}-${index}`} className="flex justify-between items-center text-xs bg-slate-800/50 p-1.5 rounded">
                    <strong>{face.name ?? face.match?.name ?? `Face ${index + 1}`}</strong>
                    <span className="text-emerald-400">{Math.round((face.match?.score ?? face.confidence ?? face.score) * 100)}%</span>
                  </li>
                ))}
            </ul>
          </div>
          
        </div>
      )}

      <div className={`panel-body panel-face-body ${state.collapsed ? 'hidden' : ''}`}>
        <div className={`camera-shell relative w-[320px] aspect-video rounded-3xl overflow-hidden shadow-2xl border-4 ${state.faceCameraActive ? 'border-slate-800' : 'border-slate-900/50 bg-slate-950/80'} transition-colors`}>
          <video id="face-camera-video" className={`absolute inset-0 w-full h-full object-cover ${state.faceCameraActive ? '' : 'hidden'}`} autoPlay muted playsInline />
          <canvas id="face-camera-overlay" className={`absolute inset-0 w-full h-full object-cover mix-blend-screen transition-opacity ${state.faceCameraActive && (state.debugOverlayActive || state.faceLastDetectedCount > 0) ? 'opacity-100' : 'opacity-0'}`} />
          
          <div className={`absolute inset-0 flex items-center justify-center text-sm font-semibold text-slate-500 ${state.faceCameraActive ? 'hidden' : ''}`}>
            Camera Inactive
          </div>

          {state.faceCameraActive && state.faceLastDetectedCount > 0 && (
            <div className="absolute top-3 left-3 bg-slate-950/80 backdrop-blur-md px-3 py-1.5 rounded-lg text-xs font-bold border border-emerald-500/30 text-emerald-400 shadow-lg flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              {state.faceLastFaces.map(f => f.name || f.match?.name).filter(Boolean).join(', ') || `${state.faceLastDetectedCount} unknown`}
            </div>
          )}
        </div>

        <input
          ref={uploadInputRef}
          id="face-upload-input"
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/jpg"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            await controls?.detectFile(file);
          }}
        />
      </div>
    </article>
  );
}
