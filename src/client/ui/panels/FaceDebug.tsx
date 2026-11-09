// The studio listener's face worker laid open, so the operator can judge what
// works: whether it runs (and on what), how fast, what pictures it gets and
// why one was passed over, and per face the candidates against the match
// threshold and the decision. All of it from the listener page (studio_live),
// never from this page's own, absent worker. On by default while the worker
// is not healthy; the operator's choice wins (debugOverlayActive).

import type { JSX } from 'react';
import type { StudioFaceWorkerStatus, StudioLiveFace } from '../../../shared/contracts/studio.js';
import type { AppState, AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { drawableFace } from '../../face/overlay.js';

// One empty list: a new [] on every read would re-render without end.
const NO_FACES: StudioLiveFace[] = [];

/** A check this recent means the worker is looking. */
const HEALTHY_CHECK_MS = 15_000;

export function workerHealthy(worker: StudioFaceWorkerStatus | null | undefined, now: number): boolean {
  return worker?.state === 'ready' && worker.lastCheckAt !== null && now - worker.lastCheckAt < HEALTHY_CHECK_MS;
}

/** Debug view on: the operator's choice, else while the studio listener's worker is not healthy. */
export function faceDebugOn(state: Pick<AppState, 'debugOverlayActive' | 'studioLive'>, now: number): boolean {
  return state.debugOverlayActive ?? (state.studioLive !== null && !workerHealthy(state.studioLive.faceWorker, now));
}

export function FaceDebugToggle({ store }: { store: AppStore }): JSX.Element {
  const on = useAppSelector(store, (current) => faceDebugOn(current, Date.now()));
  return (
    <label className="flex items-center gap-2 text-slate-300">
      <input type="checkbox" aria-label="Face debug" checked={on} onChange={(event) => {
        const next = event.currentTarget.checked;
        store.setState((current) => ({ ...current, debugOverlayActive: next }));
      }} />
      <span>Face debug</span>
    </label>
  );
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

function ago(at: number | null | undefined, now: number): string {
  if (!at) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

function stateLine(worker: StudioFaceWorkerStatus): string {
  switch (worker.state) {
    case 'off':
      return worker.camera ? 'not running' : 'not running: no camera on the listener page';
    case 'loading':
      return `loading: ${worker.detail ?? 'models'}`;
    case 'error':
      return `error: ${worker.detail ?? worker.error ?? 'unknown'}`;
    case 'ready':
      return `loaded${worker.backend ? ` · ${worker.backend}` : ''}${worker.threads !== undefined ? ` · ${worker.threads} thread${worker.threads === 1 ? '' : 's'}` : ''}${worker.isolated === false ? ' · not cross-origin isolated' : ''}`;
  }
}

/** One face: who, the decision, the detection score, and each candidate against the threshold. */
export function FaceCandidates({ face, threshold }: { face: StudioLiveFace; threshold: number | undefined }): JSX.Element {
  const name = face.name ?? face.match?.name ?? null;
  const decision = face.decision ?? (name ? 'match' : 'unknown');
  return (
    <div className="face-debug-face" data-decision={decision}>
      <span className={name ? 'text-emerald-300' : 'text-amber-300'}>{name ?? 'unknown'}</span>
      <span className="text-slate-400"> · {decision} · det {pct(face.confidence ?? face.score)}</span>
      <ul className="face-debug-candidates">
        {(face.matches ?? []).map((candidate, index) => (
          <li key={`${candidate.name ?? '?'}-${index}`} className={threshold !== undefined && candidate.score >= threshold ? 'text-emerald-300' : 'text-slate-400'}>
            {candidate.name ?? '?'} {pct(candidate.score)}{threshold !== undefined ? (candidate.score >= threshold ? ' ≥ ' : ' < ') + pct(threshold) : ''}
          </li>
        ))}
        {(face.matches ?? []).length === 0 && <li className="text-slate-500">no library candidates</li>}
      </ul>
    </div>
  );
}

export function FaceDebug({ store, faces: showFaces = false }: { store: AppStore; faces?: boolean }): JSX.Element | null {
  const view = useAppSelector(store, (current) => ({
    worker: current.studioLive?.faceWorker ?? null,
    observation: current.studioObservation,
    list: current.studioLive?.status.faceLastFaces ?? NO_FACES,
    reporting: current.studioLive !== null || current.studioObservation !== null,
  }));
  if (!view.reporting) return null;
  const now = Date.now();
  const worker = view.worker;
  const observed = view.observation;
  // The producer's own report (docs/face-service.md), and the browser worker's details when it is the one.
  if (!worker && !observed) return <p className="text-slate-500" id="face-debug">The studio listener reports no face worker state (an older page?).</p>;
  const faces = observed ? observed.faces.map((face) => drawableFace(face, observed.frame)) : view.list;
  if (!worker && observed) {
    return (
      <div className="face-debug flex flex-col gap-1 text-[11px]" id="face-debug" aria-label="Face debug" data-state={observed.worker.state}>
        <p><span className="text-slate-400">Faces by the {observed.worker.kind === 'service' ? 'face service' : 'browser worker'} at {observed.worker.where} </span>
          <span className={observed.worker.state === 'ready' ? 'text-emerald-300' : 'text-amber-300'}>{observed.worker.state}{observed.worker.error ? `: ${observed.worker.error}` : ''} · {observed.worker.backend}{observed.worker.threads ? ` · ${observed.worker.threads} threads` : ''}</span></p>
        <p className="text-slate-300">{observed.worker.fps} checks/s · inference {Math.round(observed.worker.inferMs)} ms · last frame {ago(observed.t, now)} · {observed.source} {observed.frame.w}×{observed.frame.h}</p>
        {showFaces && faces.map((face, index) => <FaceCandidates key={index} face={face} threshold={undefined} />)}
      </div>
    );
  }
  if (!worker) return null;
  return (
    <div className="face-debug flex flex-col gap-1 text-[11px]" id="face-debug" aria-label="Face debug" data-state={worker.state}>
      <p><span className="text-slate-400">Face worker </span><span className={worker.state === 'ready' ? 'text-emerald-300' : worker.state === 'error' ? 'text-rose-300' : 'text-amber-300'}>{stateLine(worker)}</span></p>
      <p className="text-slate-300">
        {worker.checksPerSecond} checks/s · inference {worker.inferenceMs != null ? `${worker.inferenceMs} ms` : 'n/a'} · last check {ago(worker.lastCheckAt, now)} · last face {ago(worker.lastFaceAt, now)}
      </p>
      <p className="text-slate-300">
        Pictures from {worker.source ?? '?'}{worker.frameWidth ? ` · ${worker.frameWidth}×${worker.frameHeight}` : ''} · last {ago(worker.lastFrameAt, now)}
        {worker.checkSkip ? <span className="text-amber-300"> · passed over: {worker.checkSkip}</span> : null}
      </p>
      <p className="text-slate-300">
        Vision pictures: last {ago(worker.lastVisionFrameAt, now)}{worker.visionSkip ? <span className="text-slate-400"> · not sent: {worker.visionSkip}</span> : null}
      </p>
      {worker.threshold !== undefined && <p className="text-slate-400">A match needs {pct(worker.threshold)}{worker.margin !== undefined ? ` and a ${pct(worker.margin)} lead over the next` : ''}.</p>}
      {worker.error && <p className="text-rose-300">Last error: {worker.error}</p>}
      {showFaces && faces.map((face, index) => <FaceCandidates key={index} face={face} threshold={worker.threshold} />)}
    </div>
  );
}
