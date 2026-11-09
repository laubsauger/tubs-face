import type { DetectedFace, EnrolledFace, RecognitionMatch } from '../../shared/contracts/faces.js';

export const MATCH_THRESHOLD = 0.65;
/**
 * A frame names someone only this far ahead of the next person. It was 0.01,
 * and one frame with a 0.037 lead (Rapha 0.715, Flo 0.678) named Flo "Rapha".
 * On the studio library (src/scripts/face-library-audit.ts, each sample matched
 * without its own sitting) 0.12 named nobody wrong where 0.01 named 17 of 110
 * wrong; right matches lead by 0.56 (median). Names then settle per track
 * (settle.ts).
 */
export const MATCH_MARGIN = 0.12;
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
    const accepted = acceptedMatch(matches);

    return {
      ...face,
      name: accepted?.name ?? null,
      match: accepted,
      matches,
    };
  });
}

/**
 * This frame's verdict from the best sample per name, best first: the best if
 * it clears the threshold and is MATCH_MARGIN ahead of the next name, else
 * null. Settled per track in settle.ts.
 */
export function acceptedMatch(matches: readonly RecognitionMatch[], margin = MATCH_MARGIN): RecognitionMatch | null {
  const best = matches[0] ?? null;
  const second = matches[1] ?? null;
  return best && best.score >= MATCH_THRESHOLD && (!second || best.score - second.score >= margin) ? best : null;
}
