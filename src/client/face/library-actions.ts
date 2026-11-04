// Face library actions from the Face panel: detect in an uploaded photo,
// save the detected face, rename or delete entries.

import type { AppStore } from '../state/app-state.js';
import { createFaceEntry, deleteFaceEntry, updateFaceEntry } from './library.js';
import type { FaceWorkerClient } from './worker-client.js';
import { captureFaceThumbnail } from './enrollment.js';

export async function detectUploadedFile(worker: FaceWorkerClient, file: File, store: AppStore): Promise<void> {
  store.setState((current) => ({
    ...current,
    faceWorkerBusy: true,
    faceStatus: `Processing ${file.name}`,
  }));
  store.appendLog('info', `Running face detection on ${file.name}`);

  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('2D canvas context unavailable');
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    await worker.detectOnce(imageData);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image detection failed';
    store.setState((current) => ({
      ...current,
      faceWorkerBusy: false,
      faceStatus: 'Detection failed',
    }));
    store.appendLog('error', message);
  }
}

export async function saveDetectedFace(
  store: AppStore,
  refreshFaceLibraryState: (store: AppStore) => Promise<void>,
  captureCanvas: HTMLCanvasElement,
): Promise<void> {
  const state = store.getState();
  const name = state.faceDraftName.trim();
  const face = state.faceLastFaces.find((entry) => Array.isArray(entry.embedding));
  if (!name) {
    store.appendLog('error', 'Enter a name before saving a face');
    return;
  }
  if (!face?.embedding) {
    store.appendLog('error', 'Run face detection before saving');
    return;
  }

  try {
    store.setState((current) => ({
      ...current,
      faceStatus: `Saving ${name}`,
    }));
    const thumbnail = captureFaceThumbnail(captureCanvas, face);
    await createFaceEntry({
      name,
      embedding: face.embedding,
      ...(thumbnail ? { thumbnail } : {}),
    });
    store.setState((current) => ({
      ...current,
      faceDraftName: '',
      faceStatus: `Saved ${name}`,
    }));
    store.appendLog('info', `Saved face embedding for ${name}`);
    await refreshFaceLibraryState(store);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Face save failed';
    store.setState((current) => ({
      ...current,
      faceStatus: 'Save failed',
    }));
    store.appendLog('error', message);
  }
}

export async function renameFaceEntry(
  store: AppStore,
  id: string,
  name: string,
  refreshFaceLibraryState: (store: AppStore) => Promise<void>,
): Promise<void> {
  const normalized = name.trim();
  if (!id || !normalized) {
    store.appendLog('error', 'Face rename requires an id and name');
    return;
  }

  try {
    store.setState((current) => ({
      ...current,
      faceStatus: `Renaming ${normalized}`,
    }));
    await updateFaceEntry({ id, name: normalized });
    store.appendLog('info', `Renamed face to ${normalized}`);
    await refreshFaceLibraryState(store);
    store.setState((current) => ({
      ...current,
      faceStatus: `Renamed ${normalized}`,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Face rename failed';
    store.setState((current) => ({
      ...current,
      faceStatus: 'Rename failed',
    }));
    store.appendLog('error', message);
  }
}

export async function removeFaceEntry(
  store: AppStore,
  id: string,
  refreshFaceLibraryState: (store: AppStore) => Promise<void>,
): Promise<void> {
  if (!id) {
    store.appendLog('error', 'Face delete requires an id');
    return;
  }

  try {
    store.setState((current) => ({
      ...current,
      faceStatus: 'Removing face',
    }));
    const result = await deleteFaceEntry(id);
    if (!result.removed) {
      throw new Error('Face entry not found');
    }
    store.appendLog('info', `Removed face ${id}`);
    await refreshFaceLibraryState(store);
    store.setState((current) => ({
      ...current,
      faceStatus: 'Face removed',
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Face delete failed';
    store.setState((current) => ({
      ...current,
      faceStatus: 'Delete failed',
    }));
    store.appendLog('error', message);
  }
}
