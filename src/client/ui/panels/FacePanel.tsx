import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { AppStore } from '../../state/app-state.js';
import type { DetectedFace, EnrolledFace, RecognitionMatch } from '../../../shared/contracts/faces.js';
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
    faceWorkerReady: current.faceWorkerReady,
    faceWorkerBusy: current.faceWorkerBusy,
    faceCameraActive: current.faceCameraActive,
    faceStatus: current.faceStatus,
    faceLastDetectedCount: current.faceLastDetectedCount,
    faceLastInferenceMs: current.faceLastInferenceMs,
    faceLastEmbeddingsExtracted: current.faceLastEmbeddingsExtracted,
    faceLastEmbeddingsReused: current.faceLastEmbeddingsReused,
    faceLibraryFaces: current.faceLibraryFaces,
    faceLibraryEmbeddings: current.faceLibraryEmbeddings,
    faceLibraryPeople: current.faceLibraryPeople,
    faceDraftName: current.faceDraftName,
    faceLastFaces: current.faceLastFaces,
    faceFrameWidth: current.faceFrameWidth,
    faceFrameHeight: current.faceFrameHeight,
    debugOverlayActive: current.debugOverlayActive,
  }));
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [libraryManagerOpen, setLibraryManagerOpen] = useState(false);
  const [editingFaceId, setEditingFaceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

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
  const groupedFaces = groupLibraryFaces(state.faceLibraryFaces);

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
              <div>
                <h3>Face Library Manager</h3>
                <p>{state.faceLibraryEmbeddings} embeddings across {state.faceLibraryPeople} people</p>
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
              <ul className="face-library-groups">
                {groupedFaces.length === 0
                  ? <li className="face-item face-item-empty">No enrolled faces yet.</li>
                  : groupedFaces.map((group) => {
                    const activeEditFace = group.faces.find((face) => face.id === editingFaceId) ?? null;
                    return (
                      <li key={group.key} className="face-library-group-card">
                        <div className="face-library-group-header">
                          <div className="face-item-copy">
                            <strong>{group.name}</strong>
                            <span>{group.faces.length} embeddings</span>
                          </div>
                          <div className="face-library-actions">
                            <button
                              className="button button-danger button-compact"
                              type="button"
                              onClick={async () => {
                                if (!window.confirm(`Delete all embeddings for "${group.name}"?`)) {
                                  return;
                                }
                                for (const face of group.faces) {
                                  await controls?.deleteFace(face.id);
                                }
                                if (activeEditFace) {
                                  setEditingFaceId(null);
                                  setEditingName('');
                                }
                              }}
                            >
                              Delete All
                            </button>
                          </div>
                        </div>
                        <ul className="face-library-embedding-list">
                          {group.faces.map((face) => {
                            const editing = editingFaceId === face.id;
                            return (
                              <li key={face.id} className="face-library-embedding-row">
                                <div className="face-library-preview face-library-preview-small">
                                  {face.thumbnail ? (
                                    <img
                                      className="face-library-preview-image"
                                      src={face.thumbnail}
                                      alt={`${face.name} preview`}
                                    />
                                  ) : (
                                    <div className="face-library-preview-fallback" aria-hidden="true">
                                      {faceInitials(face.name)}
                                    </div>
                                  )}
                                </div>
                                <div className="face-library-item-main">
                                  {editing ? (
                                    <div className="face-inline-form">
                                      <input
                                        className="face-name-input"
                                        type="text"
                                        value={editingName}
                                        onChange={(event) => {
                                          setEditingName(event.currentTarget.value);
                                        }}
                                      />
                                      <button
                                        className="button button-compact"
                                        type="button"
                                        onClick={async () => {
                                          await controls?.renameFace(face.id, editingName);
                                          setEditingFaceId(null);
                                          setEditingName('');
                                        }}
                                      >
                                        Save
                                      </button>
                                      <button
                                        className="button button-secondary button-compact"
                                        type="button"
                                        onClick={() => {
                                          setEditingFaceId(null);
                                          setEditingName('');
                                        }}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="face-item-copy face-library-item-copy">
                                        <span>{face.createdAt ? `Saved ${formatFaceTimestamp(face.createdAt)}` : 'Saved face'}</span>
                                        <span className="face-item-meta" title={face.id}>{formatCompactFaceId(face.id)}</span>
                                      </div>
                                      <div className="face-library-actions">
                                        <button
                                          className="button button-secondary button-compact"
                                          type="button"
                                          onClick={() => {
                                            setEditingFaceId(face.id);
                                            setEditingName(face.name);
                                          }}
                                        >
                                          Edit
                                        </button>
                                        <button
                                          className="button button-danger button-compact"
                                          type="button"
                                          onClick={async () => {
                                            if (!window.confirm(`Delete this embedding for "${face.name}"?`)) {
                                              return;
                                            }
                                            await controls?.deleteFace(face.id);
                                            if (editingFaceId === face.id) {
                                              setEditingFaceId(null);
                                              setEditingName('');
                                            }
                                          }}
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    );
                  })}
              </ul>
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
        className={`panel-surface panel-surface-face face-panel-card transition-all ${state.collapsed ? 'is-collapsed h-11' : ''}`}
      >
      <PanelHeader store={store} panelKey="face" title="Face Worker" meta={formatFaceSummary(state)} />

      <div className={`panel-body panel-face-body ${state.collapsed ? 'hidden' : ''}`}>
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
              <video id="face-camera-video" className={`camera-video ${state.faceCameraActive ? '' : 'is-hidden'}`} autoPlay muted playsInline />
              <canvas
                id="face-camera-overlay"
                className={`camera-overlay ${state.faceCameraActive && (state.debugOverlayActive || state.faceLastDetectedCount > 0) ? '' : 'is-hidden'}`}
              />
              <div className={`camera-placeholder ${state.faceCameraActive ? 'is-hidden' : ''}`}>Camera inactive</div>
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
                  disabled={!state.faceLastFaces.some((face) => Array.isArray(face.embedding))}
                  onClick={async () => {
                    await controls?.saveDetectedFace();
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

function groupLibraryFaces(faces: EnrolledFace[]): Array<{ key: string; name: string; faces: EnrolledFace[] }> {
  const groups = new Map<string, { key: string; name: string; faces: EnrolledFace[] }>();
  for (const face of faces) {
    const key = normalizeFacePersonKey(face.name) || face.id;
    const existing = groups.get(key);
    if (existing) {
      existing.faces.push(face);
      continue;
    }
    groups.set(key, {
      key,
      name: face.name.trim() || 'Unnamed',
      faces: [face],
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      faces: [...group.faces].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
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
