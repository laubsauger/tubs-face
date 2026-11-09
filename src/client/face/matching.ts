import type { DetectedFace, EnrolledFace, RecognitionMatch } from '../../shared/contracts/faces.js';

export const MATCH_THRESHOLD = 0.65;
export const MATCH_MARGIN = 0.01;
const MAX_MATCHES = 3;

export function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function annotateDetectedFaces(faces: DetectedFace[], library: EnrolledFace[]): DetectedFace[] {
  if (faces.length === 0) {
    return faces;
  }

  return faces.map((face) => {
    if (!Array.isArray(face.embedding) || library.length === 0) {
      return {
        ...face,
        name: null,
        match: null,
        matches: [],
      };
    }

    const bestByName = new Map<string, RecognitionMatch>();
    for (const candidate of library) {
      const score = cosineSimilarity(face.embedding, candidate.embedding);
      const current = bestByName.get(candidate.name);
      if (!current || score > current.score) {
        bestByName.set(candidate.name, {
          id: candidate.id,
          name: candidate.name,
          score,
        });
      }
    }

    const matches = [...bestByName.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_MATCHES);
    const best = matches[0] ?? null;
    const second = matches[1] ?? null;
    const accepted = Boolean(
      best &&
      best.score >= MATCH_THRESHOLD &&
      (!second || (best.score - second.score) >= MATCH_MARGIN),
    );

    return {
      ...face,
      name: accepted ? best?.name ?? null : null,
      match: accepted ? best : null,
      matches,
    };
  });
}

/**
 * The face the operator picked among several in view (onboarding's choose box,
 * [x, y, w, h] in 0..1 of a width x height frame): the one overlapping it most,
 * if it overlaps at all (IoU over 0.2). Used by the browser and the face service.
 */
export function chosenFace<T extends { box: [number, number, number, number] }>(faces: readonly T[], choose: [number, number, number, number], width: number, height: number): T | null {
  const [cx, cy, cw, ch] = choose;
  const box = [cx * width, cy * height, (cx + cw) * width, (cy + ch) * height];
  let best: { face: T; overlap: number } | null = null;
  for (const face of faces) {
    const [x1, y1, x2, y2] = face.box;
    const ix = Math.max(0, Math.min(x2, box[2]!) - Math.max(x1, box[0]!));
    const iy = Math.max(0, Math.min(y2, box[3]!) - Math.max(y1, box[1]!));
    const inter = ix * iy;
    const union = (x2 - x1) * (y2 - y1) + (box[2]! - box[0]!) * (box[3]! - box[1]!) - inter;
    const overlap = union > 0 ? inter / union : 0;
    if (overlap > 0.2 && (!best || overlap > best.overlap)) best = { face, overlap };
  }
  return best?.face ?? null;
}
