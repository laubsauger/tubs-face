import { useRef, useState, type JSX } from 'react';
import type { DetectedFace } from '../../../shared/contracts/faces.js';
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
    debugOverlayActive: current.debugOverlayActive,
  }));
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [editingFaceId, setEditingFaceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  return (
    <article
      id="face-panel-card"
      className={`panel-surface panel-surface-face face-panel-card transition-all ${state.collapsed ? 'is-collapsed h-11' : ''}`}
    >
      <PanelHeader store={store} panelKey="face" title="Face Worker" meta={formatFaceSummary(state)} />

      <div className={`panel-body panel-face-body ${state.collapsed ? 'hidden' : ''}`}>
        <p id="face-summary-metric" className={`metric ${state.faceWorkerReady ? 'is-good' : 'is-bad'}`}>
          {formatFaceSummary(state)}
        </p>

        <div className={`camera-shell ${state.faceCameraActive ? '' : 'is-inactive-shell'}`}>
          <div className="camera-stage">
            <video id="face-camera-video" className={`camera-video ${state.faceCameraActive ? '' : 'is-hidden'}`} autoPlay muted playsInline />
            <canvas
              id="face-camera-overlay"
              className={`camera-overlay ${state.faceCameraActive && (state.debugOverlayActive || state.faceLastDetectedCount > 0) ? '' : 'is-hidden'}`}
            />
            <div className={`camera-placeholder ${state.faceCameraActive ? 'is-hidden' : ''}`}>Camera inactive</div>
          </div>
        </div>

        <div className="face-panel-stack">
          <dl className="kv">
            <div><dt>Status</dt><dd id="face-status-value">{state.faceStatus}</dd></div>
            <div><dt>Inference</dt><dd id="face-inference-value">{state.faceLastInferenceMs == null ? 'n/a' : `${state.faceLastInferenceMs} ms`}</dd></div>
            <div><dt>Embeddings</dt><dd id="face-embeddings-value">{state.faceLastEmbeddingsExtracted} new / {state.faceLastEmbeddingsReused} cached</dd></div>
            <div><dt>Library</dt><dd id="face-library-value">{state.faceLibraryEmbeddings} embeddings / {state.faceLibraryPeople} people</dd></div>
          </dl>

          <div className="face-actions">
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

            <div className="face-action-row">
              <button
                id="face-camera-toggle"
                className={`button ${state.faceCameraActive ? 'is-active' : ''}`}
                type="button"
                onClick={async () => {
                  await controls?.toggleCamera();
                }}
              >
                {state.faceCameraActive ? 'Stop Camera' : 'Start Camera'}
              </button>
              <button
                id="face-upload-trigger"
                className="button"
                type="button"
                disabled={state.faceWorkerBusy}
                onClick={() => {
                  uploadInputRef.current?.click();
                }}
              >
                {state.faceWorkerBusy ? 'Processing...' : 'Detect From Image'}
              </button>
              <button
                id="face-refresh-trigger"
                className="button button-secondary"
                type="button"
                onClick={async () => {
                  await controls?.refreshLibrary();
                }}
              >
                Refresh Library
              </button>
            </div>

            <div className="face-action-row">
              <input
                id="face-enroll-name"
                className="face-name-input"
                type="text"
                placeholder="Name this face"
                value={state.faceDraftName}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store.setState((current) => ({
                    ...current,
                    faceDraftName: value,
                  }));
                }}
              />
              <button
                id="face-save-trigger"
                className="button"
                type="button"
                disabled={!state.faceLastFaces.some((face) => Array.isArray(face.embedding))}
                onClick={async () => {
                  await controls?.saveDetectedFace();
                }}
              >
                Save First Face
              </button>
            </div>
          </div>

          <section className="face-panel-section">
            <div className="face-section-head">
              <h3>Current Detections</h3>
              <span>{state.faceLastDetectedCount} live</span>
            </div>
            <ul id="face-results-list" className="face-list">
              {state.faceLastFaces.length === 0
                ? <li className="face-item face-item-empty">No detections yet.</li>
                : state.faceLastFaces.map((face, index) => (
                  <li key={`${face.name ?? face.match?.name ?? 'face'}-${index}`} className="face-item face-item-detailed">
                    <div className="face-item-copy">
                      <strong>{face.name ?? face.match?.name ?? `Face ${index + 1}`}</strong>
                      <span>{renderFaceMeta(face)}</span>
                      {face.matches && face.matches.length > 0 && (
                        <div className="face-match-strip">
                          {face.matches.map((match) => (
                            <span key={`${match.id ?? match.name ?? 'match'}-${match.score.toFixed(4)}`} className={`face-match-chip ${match.id === face.match?.id ? 'is-primary' : ''}`}>
                              {match.name ?? 'Unknown'} {Math.round(match.score * 100)}%
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span>{Math.round((face.match?.score ?? face.confidence ?? face.score) * 100)}%</span>
                  </li>
                ))}
            </ul>
          </section>

          <section className="face-panel-section">
            <div className="face-section-head">
              <h3>Face Library</h3>
              <span>{state.faceLibraryFaces.length} saved</span>
            </div>
            <ul className="face-library-list">
              {state.faceLibraryFaces.length === 0
                ? <li className="face-item face-item-empty">No enrolled faces yet.</li>
                : state.faceLibraryFaces.map((face) => {
                  const editing = editingFaceId === face.id;
                  return (
                    <li key={face.id} className="face-library-item">
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
                              className="button"
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
                              className="button button-secondary"
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
                            <div className="face-item-copy">
                              <strong>{face.name}</strong>
                              <span>{face.createdAt ? `Saved ${formatFaceTimestamp(face.createdAt)}` : face.id}</span>
                            </div>
                            <div className="face-library-actions">
                              <button
                                className="button button-secondary"
                                type="button"
                                onClick={() => {
                                  setEditingFaceId(face.id);
                                  setEditingName(face.name);
                                }}
                              >
                                Rename
                              </button>
                              <button
                                className="button button-danger"
                                type="button"
                                onClick={async () => {
                                  if (!window.confirm(`Delete face "${face.name}"?`)) {
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
          </section>
        </div>
      </div>
    </article>
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

function renderFaceMeta(face: DetectedFace): string {
  if (face.name) {
    return 'Recognized from library';
  }
  if (face.match?.name) {
    return `Closest match: ${face.match.name}`;
  }
  return 'No confident match';
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
