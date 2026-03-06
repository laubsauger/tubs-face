import type { DetectedFace, EnrolledFace, RecognitionMatch } from '../../shared/contracts/faces.js';

const MATCH_THRESHOLD = 0.65;
const MATCH_MARGIN = 0.01;
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
