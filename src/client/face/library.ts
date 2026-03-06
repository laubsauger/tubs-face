import type { EnrolledFace } from '../../shared/contracts/faces.js';
import type { FaceCreateRequest, FaceCreateResponse, FaceLibraryResponse } from '../../shared/contracts/http.js';
import { fetchJson } from '../transport/http.js';

export interface FaceLibrarySummary {
  embeddings: number;
  people: number;
}

export async function loadFaceLibrarySummary(): Promise<FaceLibrarySummary> {
  const faces = await loadFaceLibrary();
  const names = new Set(faces.map((face) => face.name).filter(Boolean));
  return {
    embeddings: faces.length,
    people: names.size,
  };
}

export async function loadFaceLibrary(): Promise<EnrolledFace[]> {
  const payload = await fetchJson<FaceLibraryResponse>('/faces');
  return Array.isArray(payload.faces) ? payload.faces : [];
}

export async function createFaceEntry(payload: FaceCreateRequest & { thumbnail?: string }): Promise<FaceCreateResponse> {
  const response = await fetch('/faces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json() as FaceCreateResponse | { error?: string };
  if (!response.ok) {
    throw new Error(typeof json === 'object' && json && 'error' in json ? String(json.error || 'Face save failed') : 'Face save failed');
  }
  return json as FaceCreateResponse;
}
