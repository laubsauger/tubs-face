// Onboarding a face: capture poses from the live camera, reject duplicates,
// save the samples with thumbnails to the library.

import type { DetectedFace } from '../../shared/contracts/faces.js';
import type { AppStore } from '../state/app-state.js';
import { createFaceEntry } from './library.js';
import { cosineSimilarity } from './matching.js';
import type { FaceWorkerClient } from './worker-client.js';

const ENROLLMENT_CAPTURE_RETRY_DELAY_MS = 250;

const ENROLLMENT_MAX_CAPTURE_ATTEMPTS = 5;

const ENROLLMENT_DUPLICATE_THRESHOLD = 0.82;

/** One captured onboarding pose. */
export interface EnrollmentCapture {
  embedding: number[];
  thumbnail: string;
  /** Too close to an earlier pose to add much to recognition. */
  duplicate: boolean;
}

export async function captureEnrollmentSample(
  worker: FaceWorkerClient,
  captureCanvas: HTMLCanvasElement,
  videoEl: HTMLVideoElement | null,
  previousEmbeddings: number[][],
): Promise<EnrollmentCapture | null> {
  if (!worker.ready) {
    throw new Error('Face worker is still loading');
  }
  for (let attempt = 0; attempt < ENROLLMENT_MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const snapshot = captureVideoFrame(videoEl, captureCanvas);
    if (!snapshot) {
      await delay(ENROLLMENT_CAPTURE_RETRY_DELAY_MS);
      continue;
    }
    const result = await worker.detectOnce(snapshot.imageData);
    const candidates = result.faces.filter((face) => Array.isArray(face.embedding));
    if (candidates.length !== 1) {
      await delay(ENROLLMENT_CAPTURE_RETRY_DELAY_MS);
      continue;
    }
    const face = candidates[0]!;
    const embedding = face.embedding!;
    const thumbnail = captureFaceThumbnail(captureCanvas, face);
    if (!thumbnail) {
      continue;
    }
    return {
      embedding,
      thumbnail,
      duplicate: previousEmbeddings.some((previous) => cosineSimilarity(previous, embedding) >= ENROLLMENT_DUPLICATE_THRESHOLD),
    };
  }
  return null;
}

export async function saveEnrollment(
  store: AppStore,
  refreshFaceLibraryState: (store: AppStore) => Promise<void>,
  nameInput: string,
  samples: Array<{ embedding: number[]; thumbnail: string }>,
): Promise<number> {
  const name = nameInput.trim();
  if (!name) {
    throw new Error('Enter a name before saving');
  }
  let saved = 0;
  for (const sample of samples) {
    await createFaceEntry({ name, embedding: sample.embedding, thumbnail: sample.thumbnail });
    saved += 1;
  }
  await refreshFaceLibraryState(store);
  store.setState((current) => ({
    ...current,
    faceDraftName: '',
    faceStatus: `Enrolled ${name} (${saved} samples)`,
  }));
  store.appendLog('info', `Enrolled ${name} with ${saved} samples`);
  return saved;
}

function captureVideoFrame(videoEl: HTMLVideoElement | null, captureCanvas: HTMLCanvasElement): { imageData: ImageData } | null {
  if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
    return null;
  }
  const context = captureCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return null;
  }
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / videoEl.videoWidth);
  const width = Math.round(videoEl.videoWidth * scale);
  const height = Math.round(videoEl.videoHeight * scale);
  captureCanvas.width = width;
  captureCanvas.height = height;
  context.drawImage(videoEl, 0, 0, width, height);
  return {
    imageData: context.getImageData(0, 0, width, height),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function captureFaceThumbnail(sourceCanvas: HTMLCanvasElement, face: DetectedFace): string | null {
  if (!sourceCanvas.width || !sourceCanvas.height) {
    return null;
  }
  const [x1, y1, x2, y2] = face.box;
  const padX = Math.max(12, Math.round((x2 - x1) * 0.18));
  const padY = Math.max(12, Math.round((y2 - y1) * 0.18));
  const sx = Math.max(0, Math.round(x1 - padX));
  const sy = Math.max(0, Math.round(y1 - padY));
  const sw = Math.min(sourceCanvas.width - sx, Math.round((x2 - x1) + padX * 2));
  const sh = Math.min(sourceCanvas.height - sy, Math.round((y2 - y1) + padY * 2));
  if (sw <= 0 || sh <= 0) {
    return null;
  }

  const canvas = document.createElement('canvas');
  const longestSide = Math.max(sw, sh);
  const scale = 112 / Math.max(1, longestSide);
  canvas.width = Math.max(72, Math.round(sw * scale));
  canvas.height = Math.max(72, Math.round(sh * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.76);
}
