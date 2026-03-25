import type { DetectedFace, EnrolledFace } from '../../shared/contracts/faces.js';
import type { AppStore } from '../state/app-state.js';
import type { WsClientMessage } from '../../shared/contracts/ws.js';
import { createFaceEntry, loadFaceLibrary } from './library.js';
import { annotateDetectedFaces } from './matching.js';
import { createFaceWorkerClient, type FaceWorkerClient } from './worker-client.js';

export interface FaceShellRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  startCamera(): Promise<void>;
  stopCamera(): void;
  detectFile(file: File): Promise<void>;
  saveDetectedFace(): Promise<void>;
  refreshLibrary(): Promise<void>;
  dispose(): void;
  attachSender(sender: ((message: WsClientMessage) => void) | null): void;
}

export function createFaceShellRuntime(store: AppStore): FaceShellRuntime {
  const FACE_STICKY_MS = 1400;
  const MAX_EMPTY_FRAMES = 2;
  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  let stream: MediaStream | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let overlayEl: HTMLCanvasElement | null = null;
  let loopTimer: number | null = null;
  let lastInferenceMs = 500;
  let faceLibrary: EnrolledFace[] = [];
  let stableFaces: DetectedFace[] = [];
  let stableFacesAt = 0;
  let emptyFrameCount = 0;
  let sender: ((message: WsClientMessage) => void) | null = null;

  const worker = createFaceWorkerClient({
    onReady: () => {
      store.setState((current) => ({
        ...current,
        faceWorkerReady: true,
        faceStatus: 'Ready',
      }));
      store.appendLog('info', 'Face worker ready');
      if (store.getState().faceCameraActive) {
        scheduleLoop();
      }
    },
    onProgress: (message) => {
      store.setState((current) => ({
        ...current,
        faceStatus: `${message.stage}: ${message.detail}`,
      }));
    },
    onFaces: (packet) => {
      const isNewAppearance = stableFaces.length === 0 && packet.faces.length > 0;
      const faces = stabilizeFaces(annotateDetectedFaces(packet.faces, faceLibrary));
      store.setState((current) => ({
        ...current,
        faceWorkerBusy: false,
        faceStatus: faces.length > 0 ? `Detected ${faces.length} face(s)` : 'No faces found',
        faceLastInferenceMs: packet.inferenceMs,
        faceLastDetectedCount: faces.length,
        faceLastEmbeddingsExtracted: packet.embeddingsExtracted,
        faceLastEmbeddingsReused: packet.embeddingsReused,
        faceFrameWidth: captureCanvas.width || current.faceFrameWidth,
        faceFrameHeight: captureCanvas.height || current.faceFrameHeight,
        faceLastFaces: faces,
      }));
      lastInferenceMs = Math.max(250, packet.inferenceMs || lastInferenceMs);
      drawOverlay(faces);

      if (isNewAppearance && sender && captureCanvas.width > 0) {
        sender({
          type: 'appearance_frame',
          frame: captureCanvas.toDataURL('image/jpeg', 0.6),
          faces: faces.map((f) => f.name || f.match?.name).filter((n): n is string => Boolean(n)),
          count: faces.length,
        });
      }

      store.appendLog('info', `Face worker finished: ${faces.length} face(s) in ${packet.inferenceMs} ms`);
      if (store.getState().faceCameraActive) {
        scheduleLoop();
      }
    },
    onError: (message) => {
      store.setState((current) => ({
        ...current,
        faceWorkerBusy: false,
        faceStatus: 'Worker error',
      }));
      if (store.getState().faceCameraActive) {
        scheduleLoop();
      }
      store.appendLog('error', `Face worker: ${message}`);
    },
  });

  function bind(root: HTMLElement): void {
    videoEl = root.querySelector<HTMLVideoElement>('#face-camera-video');
    overlayEl = root.querySelector<HTMLCanvasElement>('#face-camera-overlay');

    if (videoEl) {
      videoEl.onloadedmetadata = () => {
        syncOverlaySize();
      };
      if (stream && videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
        void videoEl.play().catch(() => { });
      }
    }

  }

  return {
    init(): void {
      worker.init();
      void refreshFaceLibraryState(store);
    },
    bind,
    startCamera(): Promise<void> {
      return startCamera(store);
    },
    stopCamera(): void {
      stopCamera(store);
    },
    detectFile(file: File): Promise<void> {
      return detectUploadedFile(worker, file, store);
    },
    saveDetectedFace(): Promise<void> {
      return saveDetectedFace(store, refreshFaceLibraryState);
    },
    refreshLibrary(): Promise<void> {
      return refreshFaceLibraryState(store);
    },
    dispose(): void {
      stopCamera(store);
      worker.terminate();
    },
    attachSender(s): void {
      sender = s;
    },
  };

  async function startCamera(appStore: AppStore): Promise<void> {
    if (stream) {
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      appStore.setState((current) => ({
        ...current,
        faceCameraActive: true,
        faceStatus: current.faceWorkerReady ? 'Camera active' : 'Loading worker',
      }));
      appStore.appendLog('info', 'Camera active');
      if (videoEl) {
        videoEl.srcObject = stream;
        await videoEl.play().catch(() => { });
        syncOverlaySize();
      }
      scheduleLoop();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Camera access failed';
      appStore.setState((current) => ({
        ...current,
        faceCameraActive: false,
        faceStatus: 'Camera error',
      }));
      appStore.appendLog('error', message);
    }
  }

  function stopCamera(appStore: AppStore): void {
    clearLoop();
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
    clearOverlay();
    stableFaces = [];
    stableFacesAt = 0;
    emptyFrameCount = 0;
    appStore.setState((current) => ({
      ...current,
      faceCameraActive: false,
      faceWorkerBusy: false,
      faceFrameWidth: null,
      faceFrameHeight: null,
      faceStatus: current.faceWorkerReady ? 'Ready' : 'Idle',
    }));
    appStore.appendLog('info', 'Camera off');
  }

  function scheduleLoop(): void {
    clearLoop();
    if (!stream || !store.getState().faceCameraActive || !worker.ready) {
      return;
    }
    const interval = Math.min(5000, Math.max(800, Math.round(lastInferenceMs * 1.5)));
    loopTimer = window.setTimeout(() => {
      void runCameraDetection();
    }, interval);
  }

  async function runCameraDetection(): Promise<void> {
    if (!stream || !videoEl || !captureCtx || worker.busy || !worker.ready) {
      scheduleLoop();
      return;
    }
    if (videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
      scheduleLoop();
      return;
    }

    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / videoEl.videoWidth);
    const width = Math.round(videoEl.videoWidth * scale);
    const height = Math.round(videoEl.videoHeight * scale);
    captureCanvas.width = width;
    captureCanvas.height = height;
    captureCtx.drawImage(videoEl, 0, 0, width, height);
    const imageData = captureCtx.getImageData(0, 0, width, height);
    store.setState((current) => ({
      ...current,
      faceWorkerBusy: true,
      faceStatus: 'Detecting from camera',
    }));
    try {
      await worker.detectOnce(imageData);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Live detection failed';
      store.appendLog('error', message);
      scheduleLoop();
    }
  }

  function syncOverlaySize(): void {
    if (!videoEl || !overlayEl) {
      return;
    }
    overlayEl.width = videoEl.videoWidth || 640;
    overlayEl.height = videoEl.videoHeight || 480;
    drawOverlay(store.getState().faceLastFaces);
  }

  function drawOverlay(faces: DetectedFace[]): void {
    if (!overlayEl) {
      return;
    }
    const context = overlayEl.getContext('2d');
    if (!context) {
      return;
    }
    context.clearRect(0, 0, overlayEl.width, overlayEl.height);
    context.lineWidth = 3;
    context.strokeStyle = '#34d399';
    context.fillStyle = 'rgba(52, 211, 153, 0.14)';
    context.font = '14px IBM Plex Sans, sans-serif';
    const scaleX = overlayEl.width / Math.max(1, captureCanvas.width || overlayEl.width);
    const scaleY = overlayEl.height / Math.max(1, captureCanvas.height || overlayEl.height);

    for (const face of faces) {
      const [x1, y1, x2, y2] = face.box;
      const left = x1 * scaleX;
      const top = y1 * scaleY;
      const width = (x2 - x1) * scaleX;
      const height = (y2 - y1) * scaleY;
      const label = face.name ?? face.match?.name ?? 'Unknown';
      const confidence = Math.round((face.match?.score ?? face.confidence ?? face.score) * 100);
      context.fillStyle = 'rgba(52, 211, 153, 0.14)';
      context.fillRect(left, top, width, height);
      context.strokeRect(left, top, width, height);
      context.fillStyle = '#d1fae5';
      context.fillText(`${label} ${confidence}%`, left + 8, Math.max(18, top - 8));
      context.fillStyle = 'rgba(52, 211, 153, 0.14)';
    }
  }

  function clearOverlay(): void {
    if (!overlayEl) {
      return;
    }
    const context = overlayEl.getContext('2d');
    context?.clearRect(0, 0, overlayEl.width, overlayEl.height);
  }

  function clearLoop(): void {
    if (loopTimer != null) {
      window.clearTimeout(loopTimer);
      loopTimer = null;
    }
  }

  async function refreshFaceLibraryState(appStore: AppStore): Promise<void> {
    try {
      const faces = await loadFaceLibrary();
      const names = new Set(faces.map((face) => face.name).filter(Boolean));
      faceLibrary = faces;
      appStore.setState((current) => ({
        ...current,
        faceLibraryEmbeddings: faces.length,
        faceLibraryPeople: names.size,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load face library';
      appStore.appendLog('error', message);
    }
  }

  function stabilizeFaces(nextFaces: DetectedFace[]): DetectedFace[] {
    const now = Date.now();
    if (nextFaces.length > 0) {
      stableFaces = nextFaces;
      stableFacesAt = now;
      emptyFrameCount = 0;
      return nextFaces;
    }

    emptyFrameCount += 1;
    if (stableFaces.length > 0 && emptyFrameCount <= MAX_EMPTY_FRAMES && (now - stableFacesAt) <= FACE_STICKY_MS) {
      return stableFaces;
    }

    stableFaces = [];
    stableFacesAt = 0;
    return [];
  }
}

async function detectUploadedFile(worker: FaceWorkerClient, file: File, store: AppStore): Promise<void> {
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

async function saveDetectedFace(
  store: AppStore,
  refreshFaceLibraryState: (store: AppStore) => Promise<void>,
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
    await createFaceEntry({
      name,
      embedding: face.embedding,
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
