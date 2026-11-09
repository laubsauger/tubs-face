import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { AppStore } from '../../state/app-state.js';
import type { DetectedFace, EnrolledFace } from '../../../shared/contracts/faces.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { StudioCameraView } from './StudioCamera.js';
import { deviceView } from '../../studio/live-view.js';
import { FaceDebug, FaceDebugToggle, faceDebugOn } from './FaceDebug.js';
import { SESSION_GAP_MS, groupLibrary } from '../../face/library-sessions.js';
import type { StudioLiveFace } from '../../../shared/contracts/studio.js';
import type { AppShellControls } from '../app-shell.js';

export function FacePanel({
  store,
  controls,
}: {
  store: AppStore;
  controls?: AppShellControls['face'];
}): JSX.Element {
  const state = useAppSelector(store, (current) => {
    // In studio mode the studio listener's face worker, not this page's (live-view.ts).
    const device = deviceView(current);
    return {
    faceWorkerReady: device.faceWorkerReady,
    faceWorkerBusy: device.faceWorkerBusy,
    faceCameraActive: device.faceCameraActive,
    faceStatus: device.faceStatus,
    faceLastDetectedCount: device.faceLastDetectedCount,
    faceLastInferenceMs: device.faceLastInferenceMs,
    faceLastEmbeddingsExtracted: device.faceLastEmbeddingsExtracted,
    faceLastEmbeddingsReused: device.faceLastEmbeddingsReused,
    faceLibraryFaces: current.faceLibraryFaces,
    faceLibraryEmbeddings: current.faceLibraryEmbeddings,
    faceLibraryPeople: current.faceLibraryPeople,
    faceDraftName: current.faceDraftName,
    faceLastFaces: device.faceLastFaces,
    faceFrameWidth: device.faceFrameWidth,
    faceFrameHeight: device.faceFrameHeight,
    debugOverlayActive: current.debugOverlayActive,
    // Studio mode: the studio listener's camera instead of one here.
    studioCamera: device.studio,
    faceDebug: device.studio && faceDebugOn(current, Date.now()),
    threshold: current.studioLive?.faceWorker?.threshold,
    };
  });
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [libraryManagerOpen, setLibraryManagerOpen] = useState(false);

  useEffect(() => {
    if (!libraryManagerOpen) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLibraryManagerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [libraryManagerOpen]);

  const cameraAspectRatio = state.faceFrameWidth && state.faceFrameHeight
    ? `${state.faceFrameWidth} / ${state.faceFrameHeight}`
    : '4 / 3';

  const libraryDialog = libraryManagerOpen && typeof document !== 'undefined'
    ? createPortal(
        <div className="face-library-dialog-backdrop" role="presentation" onClick={() => setLibraryManagerOpen(false)}>
          <div
            className="face-library-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Face Library Manager"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="face-library-dialog-header">
              <div className="face-library-dialog-title">
                <h3>Face Library</h3>
                <p>{state.faceLibraryPeople} people, {state.faceLibraryEmbeddings} embeddings</p>
              </div>
              <div className="face-library-dialog-actions">
                <button
                  className="button button-secondary button-compact"
                  type="button"
                  onClick={async () => {
                    await controls?.refreshLibrary();
                  }}
                >
                  Reload
                </button>
                <button
                  className="button button-secondary button-compact"
                  type="button"
                  onClick={() => {
                    setLibraryManagerOpen(false);
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="face-library-dialog-body">
              <LibraryPeople faces={state.faceLibraryFaces} controls={controls} />
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <article
        id="face-panel-card"
        className="dock-section face-panel-card"
      >
      <PanelHeader title="Face Worker" meta={formatFaceSummary(state)} />

      <div className="panel-body panel-face-body">
        <div className="face-panel-stack">
          <input
            ref={uploadInputRef}
            id="face-upload-input"
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/jpg"
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (!file) {
                return;
              }
              await controls?.detectFile(file);
            }}
          />

          <div className={`camera-shell ${state.faceCameraActive ? '' : 'is-inactive-shell'}`}>
            <div className="camera-stage" style={{ aspectRatio: cameraAspectRatio }}>
              <video id="face-camera-video" className={`camera-video ${state.faceCameraActive && !state.studioCamera ? '' : 'is-hidden'}`} autoPlay muted playsInline />
              <canvas
                id="face-camera-overlay"
                className={`camera-overlay ${state.faceCameraActive && !state.studioCamera && (state.debugOverlayActive || state.faceLastDetectedCount > 0) ? '' : 'is-hidden'}`}
              />
              <StudioCameraView store={store} detail={state.faceDebug} />
              <div className={`camera-placeholder ${state.faceCameraActive || state.studioCamera ? 'is-hidden' : ''}`}>Camera inactive</div>
            </div>
          </div>

          <div className="face-actions face-actions-hud">
            <div className="face-panel-toolbar">
              <div className="face-panel-toolbar-primary">
                <button
                  id="face-camera-toggle"
                  className={`button button-compact ${state.faceCameraActive ? 'is-active' : ''}`}
                  type="button"
                  onClick={async () => {
                    await controls?.toggleCamera();
                  }}
                >
                  {state.faceCameraActive ? 'Stop Cam' : 'Start Cam'}
                </button>
                <button
                  className="button button-compact"
                  type="button"
                  title="Teach Tubs a new face (F)"
                  onClick={() => {
                    store.setState((current) => ({ ...current, faceEnrollOpen: true }));
                  }}
                >
                  Onboard
                </button>
              </div>
              <div className="face-panel-toolbar-utility">
                <button
                  id="face-refresh-trigger"
                  className="button button-secondary button-compact"
                  type="button"
                  title="Reload face library"
                  onClick={async () => {
                    await controls?.refreshLibrary();
                  }}
                >
                  Sync
                </button>
                <button
                  className="button button-secondary button-compact"
                  type="button"
                  title="Open face library manager"
                  onClick={() => {
                    setLibraryManagerOpen(true);
                  }}
                >
                  Library
                </button>
                <button
                  id="face-upload-trigger"
                  className="button button-secondary button-compact"
                  type="button"
                  title="Detect faces from an uploaded image"
                  disabled={state.faceWorkerBusy}
                  onClick={() => {
                    uploadInputRef.current?.click();
                  }}
                >
                  {state.faceWorkerBusy ? 'Working' : 'Upload'}
                </button>
              </div>
            </div>

            <div className="face-action-row">
              <input
                id="face-enroll-name"
                className="face-name-input"
                type="text"
                placeholder="Face name"
                value={state.faceDraftName}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store.setState((current) => ({
                    ...current,
                    faceDraftName: value,
                  }));
                }}
              />
            </div>

            <dl className="face-kv-hud">
              <div className="face-kv-chip"><dt>Status</dt><dd id="face-status-value">{state.faceStatus}</dd></div>
              <div className="face-kv-chip"><dt>Inference</dt><dd id="face-inference-value">{state.faceLastInferenceMs == null ? 'n/a' : `${state.faceLastInferenceMs} ms`}</dd></div>
              <div className="face-kv-chip"><dt>Embeddings</dt><dd id="face-embeddings-value">{state.faceLastEmbeddingsExtracted} new / {state.faceLastEmbeddingsReused} cached</dd></div>
              <div className="face-kv-chip"><dt>Library</dt><dd id="face-library-value">{state.faceLibraryEmbeddings} embeddings / {state.faceLibraryPeople} people</dd></div>
            </dl>
          </div>

          {state.studioCamera && (
            <section className="face-panel-section face-panel-section-compact" aria-label="Studio face worker">
              <FaceDebugToggle store={store} />
              {state.faceDebug && <FaceDebug store={store} />}
            </section>
          )}

          <section className="face-panel-section face-panel-section-compact">
            <div className="face-section-head">
              <h3>Current Detections</h3>
              <span>{state.faceLastDetectedCount} live</span>
            </div>
            {state.faceLastFaces.length === 0
              ? <p className="face-empty-copy">No detections yet.</p>
              : (
                <div id="face-results-list" className="face-detection-list">
                  {state.faceLastFaces.map((face, index) => (
                    <article key={`${face.name ?? face.match?.name ?? 'face'}-${index}`} className="face-detection-card">
                      <div className="face-detection-header">
                        <span className="face-detection-index">Face #{index + 1}</span>
                        <span className="face-detection-confidence">
                          Det {formatPercent(face.confidence ?? face.score)}
                        </span>
                      </div>
                      <div className="face-detection-identity">
                        <strong>{resolvePrimaryFaceLabel(face, index)}</strong>
                        <span>
                          {face.match
                            ? `Likely ${face.match.name ?? 'match'} at ${formatPercent(face.match.score)}`
                            : 'No confident library match'}
                        </span>
                        {state.faceDebug && (
                          <span className="face-debug-decision">
                            {(face as StudioLiveFace).decision ?? (face.match ? 'match' : 'unknown')}
                            {state.threshold !== undefined ? ` · a match needs ${formatPercent(state.threshold)}` : ''}
                          </span>
                        )}
                      </div>
                      <div className="face-detection-candidates">
                        {face.matches && face.matches.length > 0
                          ? face.matches.map((match) => (
                            <div
                              key={`${match.id ?? match.name ?? 'match'}-${match.score.toFixed(4)}`}
                              className={`face-candidate-row ${match.id === face.match?.id ? 'is-primary' : ''}`}
                            >
                              <span className="face-candidate-name">{match.name ?? 'Unknown'}</span>
                              <span className="face-candidate-score">{formatPercent(match.score)}</span>
                            </div>
                          ))
                          : <div className="face-candidate-empty">No library candidates yet.</div>}
                      </div>
                    </article>
                  ))}
                </div>
              )}
          </section>
        </div>
      </div>
      </article>
      {libraryDialog}
    </>
  );
}

function formatFaceSummary(state: {
  faceWorkerBusy: boolean;
  faceWorkerReady: boolean;
  faceLastDetectedCount: number;
}): string {
  if (state.faceWorkerBusy) return 'Running';
  if (!state.faceWorkerReady) return 'Loading worker';
  return state.faceLastDetectedCount > 0 ? `${state.faceLastDetectedCount} detected` : 'Ready';
}

function formatFaceTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

function formatCompactFaceId(id: string): string {
  const value = id.trim();
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function faceInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) {
    return '??';
  }
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('').slice(0, 2);
}

function normalizeFacePersonKey(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase();
}

function resolvePrimaryFaceLabel(face: DetectedFace, index: number): string {
  return face.match?.name ?? face.name ?? face.matches?.[0]?.name ?? `Unknown Face ${index + 1}`;
}

function formatPercent(score: number | null | undefined): string {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) {
    return 'n/a';
  }
  return `${Math.round(numeric * 100)}%`;
}

/**
 * The library as people: one block each (name, samples, newest sample),
 * folded when there are many; inside, a row of thumbnails per capture session
 * (samples taken minutes apart at most: the library keeps no session, so it is
 * read from their times, face/library-sessions.ts). Rename or remove a
 * person, remove a session, or remove one sample on hover.
 */
function LibraryPeople({ faces, controls }: { faces: EnrolledFace[]; controls: AppShellControls['face'] }): JSX.Element {
  const people = groupLibrary(faces);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const removeAll = async (list: EnrolledFace[]) => {
    for (const face of list) await controls?.deleteFace(face.id);
  };
  if (people.length === 0) return <p className="face-item face-item-empty">No enrolled faces yet.</p>;
  return (
    <div className="face-library-people">
      <p className="text-slate-500 text-[11px]">Sessions are samples taken within {SESSION_GAP_MS / 60_000} minutes of each other (the library keeps their times, not the sitting).</p>
      <ul className="face-library-groups">
        {people.map((person) => {
          const expanded = open[person.key] ?? !person.foldedByDefault;
          const editing = renaming?.key === person.key;
          return (
            <li key={person.key} className="face-library-group-card" aria-label={`Library person ${person.name}`}>
              <div className="face-library-group-header">
                <button type="button" className="face-library-fold" aria-expanded={expanded} onClick={() => setOpen({ ...open, [person.key]: !expanded })}>
                  {expanded ? '▾' : '▸'}
                </button>
                <div className="face-item-copy face-library-group-copy">
                  {editing ? (
                    <div className="face-inline-form">
                      <input className="face-name-input" aria-label="New name" value={renaming.name} onChange={(event) => setRenaming({ key: person.key, name: event.currentTarget.value })} />
                      <button type="button" className="button button-compact" disabled={!renaming.name.trim()} onClick={async () => {
                        for (const session of person.sessions) for (const face of session.faces) await controls?.renameFace(face.id, renaming.name.trim());
                        setRenaming(null);
                      }}>Save</button>
                      <button type="button" className="button button-secondary button-compact" onClick={() => setRenaming(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <strong>{person.name}</strong>
                      <span>
                        {person.samples} sample{person.samples === 1 ? '' : 's'} · {person.sessions.length} session{person.sessions.length === 1 ? '' : 's'}
                        {person.lastSampleAt ? ` · newest ${formatFaceTimestamp(person.lastSampleAt)}` : ''}
                      </span>
                    </>
                  )}
                </div>
                <div className="face-library-actions face-library-hover-actions">
                  <button type="button" className="button button-secondary button-compact" onClick={() => setRenaming({ key: person.key, name: person.name })}>Rename</button>
                  <button type="button" className="button button-danger button-compact" onClick={async () => {
                    if (!window.confirm(`Delete all ${person.samples} samples of "${person.name}"?`)) return;
                    await removeAll(person.sessions.flatMap((session) => session.faces));
                  }}>Remove</button>
                </div>
              </div>
              {expanded && (
                <ul className="face-library-sessions">
                  {person.sessions.map((session) => (
                    <li key={session.key} className="face-library-session" aria-label={`Session ${session.startedAt ? formatFaceTimestamp(session.startedAt) : 'undated'}`}>
                      <div className="face-library-session-head">
                        <span>{session.startedAt ? formatFaceTimestamp(session.startedAt) : 'Undated'} · {session.faces.length}</span>
                        <button type="button" className="button button-danger button-compact face-library-hover-actions" onClick={async () => {
                          if (!window.confirm(`Delete these ${session.faces.length} samples of "${person.name}"?`)) return;
                          await removeAll(session.faces);
                        }}>Remove session</button>
                      </div>
                      <div className="face-library-session-thumbs">
                        {session.faces.map((face) => (
                          <div key={face.id} className="face-library-thumb" title={face.createdAt ? formatFaceTimestamp(face.createdAt) : face.id}>
                            {face.thumbnail
                              ? <img src={face.thumbnail} alt={`${face.name} sample`} />
                              : <span className="face-library-preview-fallback" aria-hidden="true">{faceInitials(face.name)}</span>}
                            <button type="button" className="face-library-thumb-remove" aria-label={`Remove this sample of ${face.name}`} onClick={async () => {
                              if (!window.confirm(`Delete this sample of "${face.name}"?`)) return;
                              await controls?.deleteFace(face.id);
                            }}>×</button>
                          </div>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
