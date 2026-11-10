import type { DetectedFace, EnrolledFace } from '../../shared/contracts/faces.js';
import type { AppStore } from '../state/app-state.js';
import type { WsClientMessage } from '../../shared/contracts/ws.js';
import { loadFaceLibraryIntoStore } from './library.js';
import { annotateDetectedFaces } from './matching.js';
import { createGreetingHold, createNameSettler } from './settle.js';
import { type Snapshot, wantsSnapshot } from './auto-onboarding.js';
import { RETURN_GREETING_MIN_AWAY_MS, createVisitorTracker, type VisitorEvent } from './visitor-tracker.js';
import { createPeopleTracker, type TrackedPerson } from './people-tracker.js';
import { createFaceWorkerClient } from './worker-client.js';
import { type EnrollmentCapture, captureEnrollmentSample, captureFaceThumbnail, saveEnrollment } from './enrollment.js';
import { uploadVerdict } from './person-match.js';

/** A photo turned into a sample, or the reason it can't be (embedPicture). */
export type EmbedResult = { ok: true; sample: EnrollmentCapture } | { ok: false; reason: string };
import { detectUploadedFile, removeFaceEntry, renameFaceEntry, saveDetectedFace } from './library-actions.js';
import { createStillPictures, snapshotPicture, visionFrame, type StillPictures } from './pictures.js';
import { whepPicture } from '../transport/whip.js';
import { formatVisionSource, type VisionSourceSpec } from '../../shared/contracts/studio.js';
import { RENDER_PAUSE_POLL_MS, faceChecksPaused } from './render-pause.js';
import { drawFaceBoxes } from './overlay.js';
import { MATCH_MARGIN, MATCH_THRESHOLD } from './matching.js';
import type { FaceObservation, StudioFaceWorkerStatus } from '../../shared/contracts/studio.js';
import { observedFaces, type ObservationTracks } from './observation.js';

/** How long a photo waits for a check in progress to finish. */
const EMBED_WAIT_MS = 5000;
/** Checks per second are counted over this window. */
const CHECK_RATE_WINDOW_MS = 10_000;

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
  /** Grab one pose; null when no single face was found (or not the chosen one: box [x, y, w, h] in 0..1). */
  captureEnrollmentSample(previousEmbeddings: number[][], choose?: [number, number, number, number]): Promise<EnrollmentCapture | null>;
  /**
   * A sample from a photo (an upload for someone's samples): detected, aligned
   * and embedded like a camera pose; refused with the reason unless it holds
   * exactly one face. It never counts as someone in view.
   */
  embedPicture(image: Blob): Promise<EmbedResult>;
  /**
   * The studio switches. recognition: faces are matched against the library
   * (names, relationships) and auto-onboarded. detection: the worker looks for
   * faces at all, while recognition or vision descriptions (which a detected
   * face triggers) is on.
   */
  setRecognition(recognition: boolean, detection: boolean): void;
  /** The last check as a FaceObservation (docs/face-service.md): the same shape the face service sends. */
  observation(now?: number): FaceObservation;
  /** Called with each check's observation (the studio listener sends it on). */
  onObservation(sink: ((observation: FaceObservation) => void) | null): void;
  /** The face worker's state for the studio's operators (studio_status faceWorker): running or not, how fast, what it found. */
  debugStatus(now?: number): StudioFaceWorkerStatus;
  /**
   * What the camera shows now, as a small JPEG, for a dashboard that watches
   * the studio listener; key changes only with the picture (a still camera's
   * picture is sent once). null without a camera.
   */
  previewFrame(maxPx: number): { frame: string; width: number; height: number; key: number } | null;
  saveEnrollment(name: string, samples: Array<{ embedding: number[]; thumbnail: string }>): Promise<number>;
  /** Enroll a person from the snapshots taken while they were in view (auto onboarding). */
  autoEnroll(personId: string, name: string): Promise<void>;
  refreshLibrary(): Promise<void>;
  renameFace(id: string, name: string): Promise<void>;
  deleteFace(id: string): Promise<void>;
  dispose(): void;
  attachSender(sender: ((message: WsClientMessage) => void) | null): void;
  /**
   * Where pictures come from (docs/vision.md): the page's camera (by label),
   * a snapshot URL (fetched through the server's /studio/snapshot), a site
   * node stream (opened only per picture), or none. Studio mode sets it.
   */
  setPictureSource(source: VisionSourceSpec, site: string): Promise<void>;
}

export interface FaceShellOptions {
  /** No operator dock (a studio face page): the camera plays in a video element of its own. */
  headless?: boolean;
}

export function createFaceShellRuntime(store: AppStore, options: FaceShellOptions = {}): FaceShellRuntime {
  const FACE_STICKY_MS = 1400;
  let lastVisionFrameAt = 0;
  // A snapshot URL or a site node stream: pictures taken one at a time.
  let still: StillPictures | null = null;
  let stillGrab: (() => Promise<ImageBitmap>) | null = null;
  // Counts the still pictures, so a preview sends each one once.
  let stillCount = 0;
  const previewCanvas = document.createElement('canvas');
  const MAX_EMPTY_FRAMES = 2;
  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  let stream: MediaStream | null = null;
  let videoEl: HTMLVideoElement | null = null;
  if (options.headless) {
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
  }
  let overlayEl: HTMLCanvasElement | null = null;
  let loopTimer: number | null = null;
  let lastInferenceMs = 500;
  let faceLibrary: EnrolledFace[] = [];
  let stableFaces: DetectedFace[] = [];
  let stableFacesAt = 0;
  let emptyFrameCount = 0;
  let sender: ((message: WsClientMessage) => void) | null = null;
  let uploadPending = false;
  const visitorTracker = createVisitorTracker();
  const peopleTracker = createPeopleTracker();
  const snapshots = new Map<string, Snapshot[]>();
  let lastPeopleSignature = '';
  let lastPeopleSentAt = 0;
  // Who is in view is confirmed at least this often while anyone is (the
  // server drops a recognised person it has not heard about for ~10 s).
  const PEOPLE_REFRESH_MS = 5000;
  let enrollmentActive = false;
  // Studio switches: recognition names the faces (matching, auto-onboarding);
  // detection runs while recognition or descriptions (faces trigger them) is on.
  let recognition = true;
  let detection = true;
  let embedPending = false;
  let observationSink: ((observation: FaceObservation) => void) | null = null;
  const tracks: ObservationTracks = { next: 1, last: [] };
  const nameSettler = createNameSettler();
  const greetingHold = createGreetingHold<{ returning: boolean; awayMs?: number }>();
  // What the studio's operators see of this worker (debugStatus), never sent anywhere else.
  const debug = {
    initStarted: false,
    info: null as { backend?: string; threads?: number; isolated?: boolean } | null,
    error: null as { message: string; at: number } | null,
    checks: [] as number[],
    lastCheckAt: null as number | null,
    lastFaceAt: null as number | null,
    faces: 0,
    best: null as { name: string | null; prob: number } | null,
    source: 'off',
    lastFrameAt: null as number | null,
    visionSkip: null as Exclude<StudioFaceWorkerStatus['visionSkip'], undefined>,
    checkSkip: null as Exclude<StudioFaceWorkerStatus['checkSkip'], undefined>,
  };

  const worker = createFaceWorkerClient({
    onReady: (info) => {
      debug.info = info;
      debug.error = null;
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
      // A photo being turned into a sample (embedPicture) is nobody in view.
      if (embedPending) {
        store.setState((current) => ({ ...current, faceWorkerBusy: false }));
        return;
      }
      // A detection still in flight when the camera was turned off would
      // refill the faces, and with the loop stopped they stayed "present"
      // forever (no sleep, proactive lines to an empty room).
      if (!stream && !still && !uploadPending) {
        return;
      }
      const wasEmpty = stableFaces.length === 0;
      // Recognition off: faces are found (descriptions need them), never named.
      // Names per track, not per frame: a face is named once its track matched that person on a few checks (settle.ts).
      const settled = nameSettler.settle(annotateDetectedFaces(packet.faces, recognition ? faceLibrary : []), Date.now());
      const faces = stabilizeFaces(settled);
      noteCheck(faces, Date.now());
      observationSink?.(observation());
      const recognizedNames = [...new Set(
        faces
          .map((face) => face.match?.name ?? face.name ?? null)
          .filter((name): name is string => Boolean(name?.trim()))
          .map((name) => name.trim()),
      )];
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
      const people = peopleTracker.update(faces, captureCanvas.width, now);
      const greeting = handleVisitorEvents(visitorTracker.update(faces, now, now < store.getState().conversationUntil, people.map((person) => person.id)), faces.length);
      reportPeople(people, now);
      // Someone new joined people already in view. Not on recognition or
      // face-count flicker: each flicker used to send a fresh greeting.
      const groupChanged = faces.length > 0 && !wasEmpty && people.some((person) => person.joined);
      // A known face's first check only starts its name: the greeting waits briefly for it (settle.ts).
      const appearance = greetingHold.next({ faces: faces.length, trigger: Boolean(greeting || groupChanged), greeting, nameOnItsWay: settled.some((face) => face.pending), now });
      const shouldSendAppearance = Boolean(sender && captureCanvas.width > 0 && appearance.send);

      const config = store.getState().config;
      const maxPx = config?.visionMaxPx ?? 512;
      // The server keeps the budget too; here no picture leaves for nothing.
      const descriptions = config?.visionProvider !== 'off' && config?.visionDescriptions !== false;
      const refreshAllowed = descriptions && (!store.getState().sleeping || config?.visionWhileAsleep === true);
      if (shouldSendAppearance && sender) {
        sender({
          type: 'appearance_frame',
          frame: visionFrame(captureCanvas, maxPx),
          // Names stick to a person once recognized, so a missed frame still greets by name.
          faces: [...new Set([...recognizedNames, ...people.flatMap((person) => person.names)])],
          count: faces.length,
          ...(appearance.greeting?.returning ? { returning: true, awayMs: appearance.greeting.awayMs } : {}),
        });
        lastVisionFrameAt = Date.now();
        debug.visionSkip = null;
      } else if (!appearance.holding && refreshAllowed && faces.length > 0 && sender && captureCanvas.width > 0 && Date.now() - lastVisionFrameAt >= (config?.visionRefreshMs ?? 30_000)) {
        // The server forgets a camera description after 60 s. While someone is
        // still in view, refresh it (vision only, no new greeting).
        sender({ type: 'camera_frame', frame: visionFrame(captureCanvas, maxPx) });
        lastVisionFrameAt = Date.now();
        debug.visionSkip = null;
      } else {
        debug.visionSkip = faces.length === 0 ? 'nobody in view'
          : appearance.holding ? 'waiting for a name to settle'
          : !descriptions ? 'descriptions off'
            : !refreshAllowed ? 'asleep' : 'not due';
      }

      store.appendLog('info', `Face worker finished: ${faces.length} face(s) in ${packet.inferenceMs} ms`);
      if (store.getState().faceCameraActive) {
        scheduleLoop();
      }
    },
    onError: (message) => {
      debug.error = { message: message.slice(0, 300), at: Date.now() };
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
    if (options.headless) return;
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
      debug.initStarted = true;
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
    captureEnrollmentSample(previousEmbeddings: number[][], choose?: [number, number, number, number]): Promise<EnrollmentCapture | null> {
      // A studio camera without a video: each pose is a fresh picture.
      const grab = !stream && still && stillGrab ? stillGrab : null;
      return captureEnrollmentSample(worker, captureCanvas, videoEl, previousEmbeddings, grab ? async () => {
        const picture = await grab();
        if (!drawPicture(picture)) return null;
        // The preview shows the pose that was taken.
        stillCount += 1;
        return { imageData: captureCtx!.getImageData(0, 0, captureCanvas.width, captureCanvas.height) };
      } : undefined, choose);
    },
    async embedPicture(image) {
      if (!worker.ready) return { ok: false, reason: 'the face worker is not ready yet' };
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(image);
      } catch {
        return { ok: false, reason: 'not an image this browser can read' };
      }
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return { ok: false, reason: 'no canvas' };
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      // The live checks wait meanwhile, and this photo's faces never count as people in view.
      const wasEnrolling = enrollmentActive;
      enrollmentActive = true;
      clearLoop();
      embedPending = true;
      try {
        for (let waited = 0; worker.busy && waited < EMBED_WAIT_MS; waited += 50) await new Promise((resolve) => window.setTimeout(resolve, 50));
        const result = await worker.detectOnce(context.getImageData(0, 0, canvas.width, canvas.height));
        const faces = result.faces.filter((face) => Array.isArray(face.embedding));
        const verdict = uploadVerdict(faces.length);
        if (!verdict.ok) return verdict;
        const thumbnail = captureFaceThumbnail(canvas, faces[0]!);
        if (!thumbnail) return { ok: false, reason: 'the face could not be cut out' };
        return { ok: true, sample: { embedding: faces[0]!.embedding!, thumbnail, duplicate: false } };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        embedPending = false;
        enrollmentActive = wasEnrolling;
        if (!wasEnrolling) scheduleLoop();
      }
    },
    debugStatus,
    observation,
    onObservation(sink) {
      observationSink = sink;
    },
    setRecognition(nextRecognition, nextDetection) {
      if (nextRecognition === recognition && nextDetection === detection) return;
      const forget = (recognition && !nextRecognition) || (detection && !nextDetection);
      recognition = nextRecognition;
      detection = nextDetection;
      store.appendLog('info', `Face recognition ${recognition ? 'on' : 'off'}, detection ${detection ? 'on' : 'off'}`);
      if (forget) {
        // Who was named (or seen) is no longer known: the server lets go of them.
        stableFaces = [];
        if (lastPeopleSignature) {
          lastPeopleSignature = '';
          sender?.({ type: 'people', people: [] });
        }
        store.setState((current) => ({ ...current, faceLastFaces: [], faceLastDetectedCount: 0, faceStatus: detection ? 'Detecting faces, not naming them' : 'Face detection off' }));
        clearOverlay();
      }
      if (detection) scheduleLoop();
      else clearLoop();
    },
    previewFrame(maxPx) {
      const live = stream && videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0;
      const source: CanvasImageSource | null = live ? videoEl : still && captureCanvas.width > 0 ? captureCanvas : null;
      if (!source) return null;
      const width = live ? videoEl!.videoWidth : captureCanvas.width;
      const height = live ? videoEl!.videoHeight : captureCanvas.height;
      const scale = Math.min(1, maxPx / Math.max(width, height));
      previewCanvas.width = Math.max(1, Math.round(width * scale));
      previewCanvas.height = Math.max(1, Math.round(height * scale));
      previewCanvas.getContext('2d')?.drawImage(source, 0, 0, previewCanvas.width, previewCanvas.height);
      return { frame: previewCanvas.toDataURL('image/jpeg', 0.6), width: previewCanvas.width, height: previewCanvas.height, key: live ? Date.now() : stillCount };
    },
    saveEnrollment(name: string, samples: Array<{ embedding: number[]; thumbnail: string }>): Promise<number> {
      return saveEnrollment(store, refreshFaceLibraryState, name, samples);
    },
    autoEnroll,
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
    async setPictureSource(source, site): Promise<void> {
      stopCamera(store);
      debug.source = formatVisionSource(source);
      debug.lastFrameAt = null;
      store.appendLog('info', `Camera source: ${formatVisionSource(source)}`);
      if (source.kind === 'off') return;
      if (source.kind === 'local') {
        await startCamera(store, source.label);
        return;
      }
      const grab = source.kind === 'snapshot'
        // Same origin: the server fetches the camera's snapshot URL.
        ? () => snapshotPicture('/studio/snapshot')
        : () => whepPicture(`${site}/${source.path}/whep`);
      startStill(grab);
    },
  };

  /** Pictures from a snapshot URL or a site stream, through the same detection as the camera's. */
  /** A still picture into captureCanvas (at most 960 wide), as the detector takes it. */
  function drawPicture(picture: ImageBitmap): boolean {
    if (!captureCtx) {
      picture.close();
      return false;
    }
    const scale = Math.min(1, 960 / picture.width);
    captureCanvas.width = Math.round(picture.width * scale);
    captureCanvas.height = Math.round(picture.height * scale);
    captureCtx.drawImage(picture, 0, 0, captureCanvas.width, captureCanvas.height);
    picture.close();
    return true;
  }

  function startStill(grab: () => Promise<ImageBitmap>): void {
    store.setState((current) => ({ ...current, faceCameraActive: true, faceStatus: 'Pictures from a remote camera' }));
    stillGrab = grab;
    still = createStillPictures({
      grab,
      ready: () => detection && worker.ready && !worker.busy && !enrollmentActive,
      onPicture: async (picture) => {
        if (!drawPicture(picture) || !captureCtx) return;
        stillCount += 1;
        debug.lastFrameAt = Date.now();
        debug.checkSkip = null;
        store.setState((current) => ({ ...current, faceWorkerBusy: true, faceStatus: 'Detecting from a remote camera' }));
        await worker.detectOnce(captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height));
      },
      onError: (message) => {
        debug.error = { message: `camera picture: ${message}`.slice(0, 300), at: Date.now() };
        debug.checkSkip = 'no frame';
        store.appendLog('error', `Camera picture: ${message}`);
      },
    });
  }

  async function startCamera(appStore: AppStore, label?: string): Promise<void> {
    if (stream) {
      return;
    }

    try {
      const deviceId = label ? await cameraByLabel(label) : null;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
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

  /** The camera with exactly this label (labels show once the page may use a camera). */
  async function cameraByLabel(label: string): Promise<string> {
    const cameras = async () => (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    let devices = await cameras();
    if (devices.every((device) => !device.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const track of probe.getTracks()) track.stop();
      devices = await cameras();
    }
    const found = devices.find((device) => device.label === label);
    if (!found) throw new Error(`No camera labelled "${label}" (there are: ${devices.map((device) => `"${device.label}"`).join(', ')})`);
    return found.deviceId;
  }

  function stopCamera(appStore: AppStore): void {
    clearLoop();
    still?.stop();
    still = null;
    stillGrab = null;
    // No camera, nobody recognised: the server lets go of who was in view at once.
    if (lastPeopleSignature) {
      lastPeopleSignature = '';
      sender?.({ type: 'people', people: [] });
    }
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
      faceLastFaces: [],
      faceLastDetectedCount: 0,
      faceStatus: current.faceWorkerReady ? 'Ready' : 'Idle',
    }));
    appStore.appendLog('info', 'Camera off');
  }

  function scheduleLoop(): void {
    clearLoop();
    if (!detection || !stream || !store.getState().faceCameraActive || !worker.ready || enrollmentActive) {
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
      debug.checkSkip = 'no frame';
      scheduleLoop();
      return;
    }
    if (faceChecksPaused(store.getState().ttsRenderingSince, Date.now())) {
      debug.checkSkip = 'voice rendering';
      clearLoop();
      loopTimer = window.setTimeout(() => {
        void runCameraDetection();
      }, RENDER_PAUSE_POLL_MS);
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
    debug.lastFrameAt = Date.now();
    debug.checkSkip = null;
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
    drawFaceBoxes(overlayEl, faces, { width: captureCanvas.width, height: captureCanvas.height }, { mirror: true });
  }

  function noteCheck(faces: DetectedFace[], now: number): void {
    debug.checks.push(now);
    while (debug.checks.length > 0 && now - debug.checks[0]! > CHECK_RATE_WINDOW_MS) debug.checks.shift();
    debug.lastCheckAt = now;
    debug.faces = faces.length;
    if (faces.length > 0) debug.lastFaceAt = now;
    // The face the library is surest of; an unknown one by its best candidate's similarity.
    const scored = faces.map((face) => ({ name: face.name ?? face.match?.name ?? null, prob: face.match?.score ?? face.matches?.[0]?.score ?? 0 }));
    debug.best = scored.sort((a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)) || b.prob - a.prob)[0] ?? null;
    if (debug.error && now - debug.error.at > CHECK_RATE_WINDOW_MS) debug.error = null;
  }

  function observation(now = Date.now()): FaceObservation {
    const status = debugStatus(now);
    const width = captureCanvas.width;
    const height = captureCanvas.height;
    const config = store.getState().config;
    return {
      t: debug.lastCheckAt ?? now,
      source: debug.source,
      frame: { w: width, h: height },
      faces: detection && status.camera
        ? observedFaces(store.getState().faceLastFaces, { width, height }, tracks, {
          // Unknown and being onboarded: the dialog has the camera, or auto onboarding holds shots.
          onboarding: enrollmentActive || (recognition && Boolean(config?.autoEnrollEnabled) && snapshots.size > 0),
        })
        : [],
      worker: {
        kind: 'browser',
        state: status.state,
        backend: debug.info?.backend ?? 'wasm',
        ...(debug.info?.threads ? { threads: debug.info.threads } : {}),
        inferMs: Math.max(0, store.getState().faceLastInferenceMs ?? 0),
        fps: status.checksPerSecond,
        ...(status.state === 'error' || status.state === 'loading' ? { error: (status.detail ?? status.error ?? status.state).slice(0, 300) } : {}),
        where: 'the studio listener page',
      },
    };
  }

  function debugStatus(now = Date.now()): StudioFaceWorkerStatus {
    const camera = Boolean(stream || still);
    const recent = debug.checks.filter((at) => now - at <= CHECK_RATE_WINDOW_MS).length;
    if (!detection) {
      return {
        state: 'off', detail: 'face recognition and vision descriptions both switched off', camera, checksPerSecond: 0, lastCheckAt: debug.lastCheckAt, lastFaceAt: debug.lastFaceAt,
        faces: 0, best: null, source: debug.source, lastVisionFrameAt: lastVisionFrameAt || null, visionSkip: debug.visionSkip, lastFrameAt: debug.lastFrameAt,
      };
    }
    const state: StudioFaceWorkerStatus['state'] = !camera ? 'off'
      : worker.ready ? 'ready'
        : debug.error ? 'error'
          : 'loading';
    return {
      state,
      ...(state === 'loading' ? { detail: debug.initStarted ? store.getState().faceStatus.slice(0, 300) : 'waiting to start' } : {}),
      ...(state === 'ready' && !recognition ? { detail: 'recognition switched off: faces are detected for descriptions, not named' } : {}),
      ...(state === 'error' && debug.error ? { detail: debug.error.message } : {}),
      camera,
      checksPerSecond: Math.round((recent / (CHECK_RATE_WINDOW_MS / 1000)) * 100) / 100,
      lastCheckAt: debug.lastCheckAt,
      lastFaceAt: debug.lastFaceAt,
      faces: debug.faces,
      best: debug.best,
      ...(debug.error ? { error: debug.error.message } : {}),
      ...(debug.info?.backend ? { backend: debug.info.backend } : {}),
      ...(debug.info?.threads !== undefined ? { threads: debug.info.threads } : {}),
      ...(debug.info?.isolated !== undefined ? { isolated: debug.info.isolated } : {}),
      source: debug.source,
      frameWidth: captureCanvas.width || null,
      frameHeight: captureCanvas.height || null,
      lastFrameAt: debug.lastFrameAt,
      inferenceMs: store.getState().faceLastInferenceMs,
      threshold: MATCH_THRESHOLD,
      margin: MATCH_MARGIN,
      lastVisionFrameAt: lastVisionFrameAt || null,
      visionSkip: debug.visionSkip,
      checkSkip: enrollmentActive ? 'onboarding' : debug.checkSkip,
    };
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
    const faces = await loadFaceLibraryIntoStore(appStore);
    if (faces) {
      faceLibrary = faces;
      // Names settled against the old library (a sample since removed) go.
      nameSettler.reset();
    }
  }

  /**
   * Tells the server who is in front of Tubs. Returns the greeting this
   * detection deserves: a first arrival or a new visitor gets one, the same
   * visitor back after a while gets a "welcome back", a glance away gets none.
   */
  /** Tells the server who is in view when the group, positions or snapshot counts change. */
  function reportPeople(people: TrackedPerson[], now: number): void {
    if (recognition && store.getState().config?.autoEnrollEnabled) {
      for (const person of people) takeSnapshot(person, now);
    }
    const counts = people.map((person) => (person.names.length === 0 ? snapshots.get(person.id)?.length ?? 0 : 0));
    const signature = people.map((person, index) => `${person.id}:${person.position}:${person.names.join(',')}:${counts[index]}`).join('|');
    const someoneBack = people.some((person) => person.awayMs !== undefined);
    const due = people.length > 0 && now - lastPeopleSentAt >= PEOPLE_REFRESH_MS;
    if (!sender || (signature === lastPeopleSignature && !someoneBack && !due)) return;
    lastPeopleSignature = signature;
    lastPeopleSentAt = now;
    sender({
      type: 'people',
      // With the first snapshot, so the memory view can show who an unnamed visitor was.
      people: people.map(({ face: _face, joined: _joined, ...person }, index) => ({
        ...person,
        ...(counts[index] ? { snapshots: counts[index], thumbnail: snapshots.get(person.id)![0]!.thumbnail } : {}),
      })),
    });
  }

  /**
   * Up to three snapshots of an unnamed person, a few seconds apart and only
   * of a big, clear face, so Tubs can enroll them the moment they say their
   * name. Memory only until then.
   */
  function takeSnapshot(person: TrackedPerson, now: number): void {
    const taken = snapshots.get(person.id) ?? [];
    if (!wantsSnapshot(person, taken, now, captureCanvas.height)) return;
    const thumbnail = captureFaceThumbnail(captureCanvas, person.face);
    if (!thumbnail) return;
    taken.push({ embedding: person.face.embedding!, thumbnail, at: now });
    snapshots.set(person.id, taken);
    // Old snapshots of people long gone are not kept around.
    for (const [id, samples] of snapshots) {
      if (now - (samples.at(-1)?.at ?? 0) > 30 * 60_000) snapshots.delete(id);
    }
  }

  /** The server heard a name: enroll that person from their snapshots. */
  async function autoEnroll(personId: string, name: string): Promise<void> {
    const samples = snapshots.get(personId);
    if (!samples || samples.length === 0) {
      store.appendLog('error', `Auto onboarding: no face snapshots for ${name}`);
      return;
    }
    try {
      await saveEnrollment(store, refreshFaceLibraryState, name, samples.map(({ embedding, thumbnail }) => ({ embedding, thumbnail })));
      snapshots.delete(personId);
      store.appendLog('info', `Auto onboarding: remembered ${name} (${samples.length} photo${samples.length === 1 ? '' : 's'})`);
    } catch (error) {
      store.appendLog('error', `Auto onboarding failed for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function handleVisitorEvents(events: VisitorEvent[], count: number): { returning: boolean; awayMs?: number } | null {
    let greeting: { returning: boolean; awayMs?: number } | null = null;
    // Someone seen earlier tonight (awayMs set) is welcomed back, not greeted as new.
    const greetFor = (awayMs: number | undefined) => (awayMs !== undefined && awayMs >= RETURN_GREETING_MIN_AWAY_MS
      ? { returning: true, awayMs }
      : { returning: false });
    for (const event of events) {
      switch (event.type) {
        case 'arrived':
          greeting = greetFor(event.awayMs);
          break;
        case 'new_visitor':
          // Before the greeting, so the server has forgotten the last visitor.
          sender?.({ type: 'presence', present: true, newVisitor: true, faces: event.names, count });
          greeting = greetFor(event.awayMs);
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
