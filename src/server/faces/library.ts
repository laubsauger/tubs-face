import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { EnrolledFace, FaceLibraryDocument } from '../../shared/contracts/faces.js';

const faceLibraryPath = resolve(process.cwd(), 'data/face-library.json');

export function readFaceLibrary(): FaceLibraryDocument {
  try {
    if (existsSync(faceLibraryPath)) {
      const parsed = JSON.parse(readFileSync(faceLibraryPath, 'utf8')) as Partial<FaceLibraryDocument>;
      return {
        faces: Array.isArray(parsed.faces) ? parsed.faces.filter(isEnrolledFaceLike) : [],
      };
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[faces] failed to read face library: ${error.message}`);
    }
  }
  return { faces: [] };
}

export function writeFaceLibrary(document: FaceLibraryDocument): void {
  mkdirSync(dirname(faceLibraryPath), { recursive: true });
  writeFileSync(faceLibraryPath, JSON.stringify(document, null, 2));
}

export function addFace(input: { name: string; embedding: number[]; thumbnail?: string }): EnrolledFace {
  const library = readFaceLibrary();
  const face: EnrolledFace = {
    id: createFaceId(),
    name: input.name,
    embedding: input.embedding,
    createdAt: Date.now(),
    ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
  };
  library.faces.push(face);
  writeFaceLibrary(library);
  return face;
}

export function deleteFace(id: string): boolean {
  const library = readFaceLibrary();
  const before = library.faces.length;
  library.faces = library.faces.filter((face) => face.id !== id);
  writeFaceLibrary(library);
  return before !== library.faces.length;
}

function createFaceId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function isEnrolledFaceLike(value: unknown): value is EnrolledFace {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<EnrolledFace>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && Array.isArray(candidate.embedding);
}
