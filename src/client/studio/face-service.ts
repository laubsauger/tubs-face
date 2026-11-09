// The studio listener page while the face service recognises (docs/face-service.md):
// it starts no face worker and loads no models; the server's face_observation
// fills the same app state fields the worker's detections would, so sleep,
// proactive lines and the live relay follow who is in view.

import type { DetectedFace } from '../../shared/contracts/faces.js';
import type { FaceObservation } from '../../shared/contracts/studio.js';
import type { WsStudioConfigServerMessage } from '../../shared/contracts/ws.js';
import type { AppState } from '../state/app-state.js';

/** Whether the listener page recognises faces itself: not while the face service does. */
export function browserRecognizes(config: Pick<WsStudioConfigServerMessage, 'enabled' | 'faces'>): boolean {
  return !(config.enabled && config.faces === 'service');
}

export type FaceStateFields = Pick<AppState,
  'faceCameraActive' | 'faceWorkerReady' | 'faceStatus' | 'faceLastDetectedCount' | 'faceFrameWidth' | 'faceFrameHeight' | 'faceLastFaces' | 'faceLastInferenceMs'>;

/** An observation as the face runtime's state: boxes back in the frame's pixels, best candidate as the match. */
export function faceStateOf(observation: FaceObservation): FaceStateFields {
  const { w, h } = observation.frame;
  const faces: DetectedFace[] = observation.faces.map((face) => {
    const [x, y, bw, bh] = face.box;
    const matches = face.candidates.map((candidate) => ({ name: candidate.name, score: candidate.sim }));
    return {
      box: [x * w, y * h, (x + bw) * w, (y + bh) * h],
      score: face.score,
      name: face.decision === 'match' ? face.name ?? null : null,
      match: face.decision === 'match' ? matches[0] ?? null : null,
      matches,
    };
  });
  const worker = observation.worker;
  return {
    faceCameraActive: true,
    faceWorkerReady: worker.state === 'ready',
    faceStatus: worker.state === 'ready'
      ? (faces.length > 0 ? `Face service: ${faces.length} face(s)` : 'Face service: no faces')
      : `Face service ${worker.state}${worker.error ? `: ${worker.error}` : ''}`.slice(0, 300),
    faceLastDetectedCount: faces.length,
    faceFrameWidth: w || null,
    faceFrameHeight: h || null,
    faceLastFaces: faces,
    faceLastInferenceMs: Math.round(worker.inferMs),
  };
}
