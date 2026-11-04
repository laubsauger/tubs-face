import type { DetectedFace, EnrolledFace } from '../../shared/contracts/faces.js';
import type { AppStore } from '../state/app-state.js';
import type { WsClientMessage } from '../../shared/contracts/ws.js';
import { loadFaceLibrary } from './library.js';
import { annotateDetectedFaces } from './matching.js';
import { RETURN_GREETING_MIN_AWAY_MS, createVisitorTracker, type VisitorEvent } from './visitor-tracker.js';
import { createFaceWorkerClient } from './worker-client.js';
import { type EnrollmentCapture, captureEnrollmentSample, saveEnrollment } from './enrollment.js';
import { detectUploadedFile, removeFaceEntry, renameFaceEntry, saveDetectedFace } from './library-actions.js';

export interface FaceShellRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  startCamera(): Promise<void>;
  stopCamera(): void;
  detectFile(file: File): Promise<void>;
  saveDetectedFace(): Promise<void>;
  /** Live camera stream, so the onboarding wizard can show the same feed. */
  getCameraStream(): MediaStream | null;
  /** Pause live detection while the wizard owns the camera. */
  beginEnrollment(): void;
  endEnrollment(): void;
  /** Grab one pose; null when no single face was found. */
  captureEnrollmentSample(previousEmbeddings: number[][]): Promise<EnrollmentCapture | null>;
  saveEnrollment(name: string, samples: Array<{ embedding: number[]; thumbnail: string }>): Promise<number>;
  refreshLibrary(): Promise<void>;
  renameFace(id: string, name: string): Promise<void>;
  deleteFace(id: string): Promise<void>;
  dispose(): void;
  attachSender(sender: ((message: WsClientMessage) => void) | null): void;
}

export function createFaceShellRuntime(store: AppStore): FaceShellRuntime {
  const FACE_STICKY_MS = 1400;
  const VISION_REFRESH_MS = 30_000;
  let lastVisionFrameAt = 0;
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
  let lastAppearanceSignature = '';
  let uploadPending = false;
  const visitorTracker = createVisitorTracker();
  let enrollmentActive = false;

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
      // A detection still in flight when the camera was turned off would
      // refill the faces, and with the loop stopped they stayed "present"
      // forever (no sleep, proactive lines to an empty room).
      if (!stream && !uploadPending) {
        return;
      }
      const wasEmpty = stableFaces.length === 0;
      const faces = stabilizeFaces(annotateDetectedFaces(packet.faces, faceLibrary));
      const recognizedNames = [...new Set(
        faces
          .map((face) => face.match?.name ?? face.name ?? null)
          .filter((name): name is string => Boolean(name?.trim()))
          .map((name) => name.trim()),
      )];
      const appearanceSignature = faces.length === 0
        ? ''
        : `${faces.length}:${recognizedNames.slice().sort((left, right) => left.localeCompare(right)).join('|')}`;
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

      const now = Date.now();
      const greeting = handleVisitorEvents(visitorTracker.update(faces, now, now < store.getState().conversationUntil), faces.length);
      // Someone joined, or a face got recognized, while people stayed in view.
      const groupChanged = faces.length > 0 && !wasEmpty && appearanceSignature !== lastAppearanceSignature;
      if (faces.length > 0) {
        lastAppearanceSignature = appearanceSignature;
      }
      const shouldSendAppearance = Boolean(sender && captureCanvas.width > 0 && faces.length > 0 && (greeting || groupChanged));

      if (shouldSendAppearance && sender) {
        sender({
          type: 'appearance_frame',
          frame: captureCanvas.toDataURL('image/jpeg', 0.6),
          faces: recognizedNames,
          count: faces.length,
          ...(greeting?.returning ? { returning: true, awayMs: greeting.awayMs } : {}),
        });
        lastVisionFrameAt = Date.now();
      } else if (faces.length > 0 && sender && captureCanvas.width > 0 && Date.now() - lastVisionFrameAt >= VISION_REFRESH_MS) {
        // The server forgets a camera description after 60 s. While someone is
        // still in view, refresh it (vision only, no new greeting).
        sender({ type: 'camera_frame', frame: captureCanvas.toDataURL('image/jpeg', 0.6) });
        lastVisionFrameAt = Date.now();
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
    async detectFile(file: File): Promise<void> {
      uploadPending = true;
      try {
        await detectUploadedFile(worker, file, store);
      } finally {
        uploadPending = false;
      }
    },
    saveDetectedFace(): Promise<void> {
      return saveDetectedFace(store, refreshFaceLibraryState, captureCanvas);
    },
    getCameraStream(): MediaStream | null {
      return stream;
    },
    beginEnrollment(): void {
      enrollmentActive = true;
      clearLoop();
    },
    endEnrollment(): void {
      enrollmentActive = false;
      scheduleLoop();
    },
    captureEnrollmentSample(previousEmbeddings: number[][]): Promise<EnrollmentCapture | null> {
      return captureEnrollmentSample(worker, captureCanvas, videoEl, previousEmbeddings);
    },
    saveEnrollment(name: string, samples: Array<{ embedding: number[]; thumbnail: string }>): Promise<number> {
      return saveEnrollment(store, refreshFaceLibraryState, name, samples);
    },
    refreshLibrary(): Promise<void> {
      return refreshFaceLibraryState(store);
    },
    renameFace(id: string, name: string): Promise<void> {
      return renameFaceEntry(store, id, name, refreshFaceLibraryState);
    },
    deleteFace(id: string): Promise<void> {
      return removeFaceEntry(store, id, refreshFaceLibraryState);
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
    lastAppearanceSignature = '';
    appStore.setState((current) => ({
      ...current,
      faceCameraActive: false,
      faceWorkerBusy: false,
      faceFrameWidth: null,
      faceFrameHeight: null,
      faceLastFaces: [],
      faceLastDetectedCount: 0,
      faceStatus: current.faceWorkerReady ? 'Ready' : 'Idle',
    }));
    appStore.appendLog('info', 'Camera off');
  }

  function scheduleLoop(): void {
    clearLoop();
    if (!stream || !store.getState().faceCameraActive || !worker.ready || enrollmentActive) {
      return;
    }
    const manualDelay = store.getState().faceDetectionDelayMs;
    const interval = manualDelay > 0
      ? manualDelay
      : Math.min(5000, Math.max(800, Math.round(lastInferenceMs * 1.5)));
    loopTimer = window.setTimeout(() => {
      void runCameraDetection();
    }, interval);
  }

  async function runCameraDetection(): Promise<void> {
    if (!stream || !videoEl || !captureCtx || worker.busy || !worker.ready || enrollmentActive) {
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
    const scaleX = overlayEl.width / Math.max(1, captureCanvas.width || overlayEl.width);
    const scaleY = overlayEl.height / Math.max(1, captureCanvas.height || overlayEl.height);

    // Main's styling: green for a recognised face, orange for an unknown one,
    // glowing box with corner accents and a label pill.
    for (const face of faces) {
      const [x1, y1, x2, y2] = face.box;
      const width = (x2 - x1) * scaleX;
      const height = (y2 - y1) * scaleY;
      const left = overlayEl.width - (x2 * scaleX);
      const top = y1 * scaleY;
      const name = face.name ?? face.match?.name ?? null;
      const color = name ? '#34d399' : '#fb923c';

      context.shadowColor = color;
      context.shadowBlur = 8;
      context.lineWidth = 3;
      context.strokeStyle = color;
      context.strokeRect(left, top, width, height);
      context.shadowBlur = 0;

      const corner = Math.min(12, width * 0.2, height * 0.2);
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(left, top + corner); context.lineTo(left, top); context.lineTo(left + corner, top);
      context.moveTo(left + width - corner, top); context.lineTo(left + width, top); context.lineTo(left + width, top + corner);
      context.moveTo(left, top + height - corner); context.lineTo(left, top + height); context.lineTo(left + corner, top + height);
      context.moveTo(left + width - corner, top + height); context.lineTo(left + width, top + height); context.lineTo(left + width, top + height - corner);
      context.stroke();

      const score = Math.round((face.match?.score ?? face.confidence ?? face.score) * 100);
      const label = name ? `${name} ${score}%` : `${score}%`;
      context.font = 'bold 12px Outfit, system-ui, sans-serif';
      const labelWidth = context.measureText(label).width + 10;
      const labelTop = Math.max(0, top - 20);
      context.fillStyle = name ? 'rgba(52, 211, 153, 0.85)' : 'rgba(251, 146, 60, 0.8)';
      context.fillRect(left, labelTop, labelWidth, 20);
      context.fillStyle = '#04121c';
      context.fillText(label, left + 5, labelTop + 15);
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
      const names = new Set(
        faces
          .map((face) => normalizeFacePersonKey(face.name))
          .filter(Boolean),
      );
      faceLibrary = faces;
      appStore.setState((current) => ({
        ...current,
        faceLibraryFaces: faces,
        faceLibraryEmbeddings: faces.length,
        faceLibraryPeople: names.size,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load face library';
      appStore.appendLog('error', message);
    }
  }

  /**
   * Tells the server who is in front of Tubs. Returns the greeting this
   * detection deserves: a first arrival or a new visitor gets one, the same
   * visitor back after a while gets a "welcome back", a glance away gets none.
   */
  function handleVisitorEvents(events: VisitorEvent[], count: number): { returning: boolean; awayMs?: number } | null {
    let greeting: { returning: boolean; awayMs?: number } | null = null;
    for (const event of events) {
      switch (event.type) {
        case 'arrived':
          greeting = { returning: false };
          break;
        case 'new_visitor':
          // Before the greeting, so the server has forgotten the last visitor.
          sender?.({ type: 'presence', present: true, newVisitor: true, faces: event.names, count });
          greeting = { returning: false };
          break;
        case 'returned':
          if (event.awayMs >= RETURN_GREETING_MIN_AWAY_MS) greeting = { returning: true, awayMs: event.awayMs };
          break;
        case 'call_back':
          sender?.({
            type: 'proactive',
            context: `${event.name} just walked away from you mid-conversation. Call them back by name, your way: annoyed, curious, or making it about you. Do not beg.`,
            faces: [event.name],
          });
          break;
        case 'gone':
          sender?.({ type: 'presence', present: false, count: 0 });
          break;
      }
    }
    return greeting;
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

function normalizeFacePersonKey(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase();
}
