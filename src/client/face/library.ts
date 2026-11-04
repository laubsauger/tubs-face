import type { EnrolledFace } from '../../shared/contracts/faces.js';
import type {
  FaceCreateRequest,
  FaceCreateResponse,
  FaceDeleteResponse,
  FaceLibraryResponse,
  FaceUpdateRequest,
  FaceUpdateResponse,
} from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { fetchJson } from '../transport/http.js';

export interface FaceLibrarySummary {
  embeddings: number;
  people: number;
}

export async function loadFaceLibrary(): Promise<EnrolledFace[]> {
  const payload = await fetchJson<FaceLibraryResponse>('/faces');
  return Array.isArray(payload.faces) ? payload.faces : [];
}

/** Loads the library into the People tab's state; null (and a logged error) if it fails. */
export async function loadFaceLibraryIntoStore(store: AppStore): Promise<EnrolledFace[] | null> {
  try {
    const faces = await loadFaceLibrary();
    const names = new Set(faces.map((face) => String(face.name ?? '').trim().toLowerCase()).filter(Boolean));
    store.setState((current) => ({
      ...current,
      faceLibraryFaces: faces,
      faceLibraryEmbeddings: faces.length,
      faceLibraryPeople: names.size,
    }));
    return faces;
  } catch (error) {
    store.appendLog('error', error instanceof Error ? error.message : 'Failed to load face library');
    return null;
  }
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

export async function updateFaceEntry(payload: FaceUpdateRequest): Promise<FaceUpdateResponse> {
  const response = await fetch('/faces', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json() as FaceUpdateResponse | { error?: string };
  if (!response.ok) {
    throw new Error(typeof json === 'object' && json && 'error' in json ? String(json.error || 'Face update failed') : 'Face update failed');
  }
  return json as FaceUpdateResponse;
}

export async function deleteFaceEntry(id: string): Promise<FaceDeleteResponse> {
  const response = await fetch(`/faces?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
    },
  });

  const json = await response.json() as FaceDeleteResponse | { error?: string };
  if (!response.ok) {
    throw new Error(typeof json === 'object' && json && 'error' in json ? String(json.error || 'Face delete failed') : 'Face delete failed');
  }
  return json as FaceDeleteResponse;
}
