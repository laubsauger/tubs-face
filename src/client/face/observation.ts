// The browser face worker's faces as a FaceObservation (docs/face-service.md),
// the shape the face service sends too: boxes in 0..1 of the frame as the
// camera sees it, the top candidates with their similarity, the decision, and
// a track number that stays while the face stays in view (by overlap with the
// last frame's boxes). No embeddings or landmarks: it goes to the dashboards.

import type { DetectedFace } from '../../shared/contracts/faces.js';
import type { FaceObservationFace } from '../../shared/contracts/studio.js';

/** Boxes overlapping the last frame's by this much (intersection over union) keep its track. */
const SAME_FACE_IOU = 0.3;
const MAX_FACES = 32;

export interface ObservationTracks {
  next: number;
  last: Array<{ track: number; box: [number, number, number, number] }>;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const overlap = x * y;
  const union = a[2] * a[3] + b[2] * b[3] - overlap;
  return union > 0 ? overlap / union : 0;
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

export function observedFaces(
  faces: ReadonlyArray<DetectedFace & { decision?: string }>,
  frame: { width: number; height: number },
  tracks: ObservationTracks,
  options: { onboarding: boolean },
): FaceObservationFace[] {
  const w = Math.max(1, frame.width);
  const h = Math.max(1, frame.height);
  const taken = new Set<number>();
  const out = faces.slice(0, MAX_FACES).map((face): FaceObservationFace => {
    const [x1, y1, x2, y2] = face.box;
    const box: [number, number, number, number] = [x1 / w, y1 / h, Math.max(0, (x2 - x1) / w), Math.max(0, (y2 - y1) / h)];
    let best: { track: number; overlap: number } | null = null;
    for (const previous of tracks.last) {
      if (taken.has(previous.track)) continue;
      const overlap = iou(box, previous.box);
      if (overlap >= SAME_FACE_IOU && (!best || overlap > best.overlap)) best = { track: previous.track, overlap };
    }
    const track = best?.track ?? tracks.next++;
    taken.add(track);
    const name = face.name ?? face.match?.name ?? null;
    const candidates = (face.matches ?? [])
      .filter((candidate): candidate is { name: string; score: number } => typeof candidate.name === 'string' && candidate.name.length > 0)
      .slice(0, 3)
      .map((candidate) => ({ name: candidate.name.slice(0, 80), sim: Math.max(-1, Math.min(1, candidate.score)) }));
    return {
      track,
      box,
      score: clampUnit(face.confidence ?? face.score),
      candidates,
      decision: name ? 'match' : options.onboarding ? 'onboarding' : 'unknown',
      ...(name ? { name: name.slice(0, 80) } : {}),
    };
  });
  tracks.last = out.map((face) => ({ track: face.track, box: face.box }));
  return out;
}
