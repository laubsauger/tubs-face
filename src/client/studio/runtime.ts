// A studio face page (studio-face.html?actor=main|small): one head, rendered
// alone on black and published to the site node with its voice, gaze and
// presence from the director. sentient-studio docs/contract.md, sections 5-6.
//
// The main page is also the listener (mic, speech-to-text, sleep and
// proactive lines), the job the operator face does outside the studio: it
// already plays main's voice and hears small's speech state from the server,
// which is all the echo guard needs, and the studio needs no third page.

import { formatVisionSource, parseMicSource, parseVisionSource, type StudioActor, type StudioCadence, type StudioDevices, type StudioMicStatus, type VisionSourceSpec } from '../../shared/contracts/studio.js';
import type { WsAudioChunkServerMessage, WsClientMessage, WsStudioConfigServerMessage, WsStudioFaceCallServerMessage, WsStudioServerMessage } from '../../shared/contracts/ws.js';
import { redirectSpeech } from '../audio/speech-level.js';
import { readVoiceClock } from '../audio/voice-clock.js';
import type { SpeechRuntime } from '../audio/speech-runtime.js';
import type { VoiceRuntime } from '../audio/voice-runtime.js';
import type { FaceBehaviorRuntime } from '../face/behavior-runtime.js';
import type { FaceShellRuntime } from '../face/runtime.js';
import type { GlitchRuntime } from '../glitch/runtime.js';
import type { AppStore } from '../state/app-state.js';
import { createBlackFrameMonitor } from './black-frame.js';
import { createStageGate } from './stage.js';
import { createHandoverGate } from './handover.js';
import { setSiteLogin } from '../transport/whip.js';
import { createCadenceMeter } from './cadence.js';
import { readInputDevices } from './devices.js';
import { LIVE_KEEPALIVE_MS, LIVE_REPORT_MS, PREVIEW_FRAME_MS, PREVIEW_MAX_PX, liveStatusOf } from './live.js';
import { takeStreamingAudioStats } from '../audio/streaming-session.js';
import { CAPTION_TICK_MS, createCaptionTracker } from './caption.js';
import { createStudioPresence } from './presence.js';
import { createFacePublisher, type PublisherStatus } from './publisher.js';
import { DEFAULT_GLYPH, drawSleepZs, layoutSleepZs, measureGlyph, type GlyphMetrics, type SleepZLayout, type SleepingFace } from './sleep-zs.js';
import { STUDIO_STATE_HEARTBEAT_MS, studioStateChanged, studioStateOf, type StudioStateSnapshot } from './state-report.js';

const CAPTURE_FPS = 30;
/** How often a face page says how steadily it renders and publishes (GET /studio actors[].cadence). */
export const CADENCE_REPORT_MS = 5000;
/** The face is published at 30 fps; drawing it faster only takes CPU and GPU from its voice. */
export const STUDIO_RENDER_MAX_FPS = 60;
/** The listener's face worker state goes to the server every this many heartbeats (2 s). */
const FACE_WORKER_REPORT_BEATS = 2;
/** An onboarding a dashboard started and then left (closed, crashed) gives the camera back after this. */
export const ENROLLMENT_IDLE_MS = 60_000;

export interface StudioRuntime {
  init(send: (message: WsClientMessage) => void): void;
  handle(message: WsStudioServerMessage): void;
  /** The listener's mic, for GET /studio. */
  noteMic(status: StudioMicStatus): void;
  dispose(): void;
}

export interface StudioRuntimeOptions {
  store: AppStore;
  actor: StudioActor;
  root: HTMLElement;
  speech: SpeechRuntime;
  faceBehavior: FaceBehaviorRuntime;
  /** The face renderer, and the stream's size in pixels (its canvas is that size). */
  glitch: GlitchRuntime;
  canvasPx: number;
  /** Only on the listener (main) page. */
  voice: VoiceRuntime | null;
  /** Only on the listener page: face detection and vision on the studio camera's pictures. */
  face?: FaceShellRuntime | null;
  /** Also play the voice on this machine's speakers (it always goes into the stream). */
  monitor: boolean;
}

export function createStudioRuntime(options: StudioRuntimeOptions): StudioRuntime {
  const { store, actor } = options;
  const listener = options.voice !== null;
  const presence = createStudioPresence();
  let send: ((message: WsClientMessage) => void) | null = null;
  let config: WsStudioConfigServerMessage | null = null;
  let voiceTrack: MediaStreamTrack | null = null;
  let stream: MediaStream | null = null;
  let stopCompositor: (() => void) | null = null;
  let pictureSource = 'off';
  // Lines wait for this head's face to be in place (studio_stage, stage.ts).
  const stage = createStageGate();
  // A line answering the other head starts a breath after that head's line played out (handover.ts).
  const handover = createHandoverGate();
  const stagedTurns = new Set<string>();
  let faceStarted = false;
  let publisherStatus: PublisherStatus = { publishing: false };
  // The published frame itself went black (see black-frame.ts).
  let frameBlack = false;
  let micStatus: StudioMicStatus | null = null;
  // The listener's input devices (GET /studio/sources); labels unlocked at most once per page.
  let devices: StudioDevices | null = null;
  let devicesProbed = false;
  // What the dashboards watch (studio_watch): nothing is sent for nobody.
  let watch = { live: false, video: false };
  let liveTimer = 0;
  let previewTimer = 0;
  let lastLiveKey = '';
  let lastLiveSentAt = 0;
  let liveSent = false;
  let lastPreviewKey = -1;
  let enrollIdleTimer = 0;
  let lastState: StudioStateSnapshot | null = null;
  let heartbeat = 0;
  let captionTimer = 0;
  let cadenceTimer = 0;
  const cadence = createCadenceMeter();
  let unsubscribeState: (() => void) | null = null;
  // A window closed by hand ends its stream, rather than leaving the site node
  // a frozen face until the connection times out.
  const onPageHide = () => publisher.dispose();
  const publisher = createFacePublisher({
    stream: faceStream,
    onStatus: (next) => {
      if (next.publishing === publisherStatus.publishing && next.error === publisherStatus.error) return;
      publisherStatus = next;
      reportStatus();
    },
    log: (message) => store.appendLog(message.includes('again') ? 'error' : 'info', `Studio ${actor}: ${message}`),
  });

  function setBadge(): void {
    const badge = options.root.querySelector<HTMLElement>('#studio-status');
    if (!badge) return;
    const stream = config?.streams[actor] ?? `tubs-${actor}`;
    const parts = [
      stream,
      !config?.enabled ? 'studio off' : publisherStatus.publishing ? 'publishing' : (publisherStatus.error ?? 'connecting'),
      ...(listener && micStatus ? [`mic ${micStatus.source}${micStatus.listening ? '' : micStatus.error ? ` (${micStatus.error})` : ' (closed)'}`] : []),
    ];
    badge.textContent = parts.join(' · ');
    badge.dataset.publishing = String(publisherStatus.publishing);
  }

  function reportStatus(withCadence?: StudioCadence): void {
    setBadge();
    const publishing = publisherStatus.publishing && !frameBlack;
    const error = frameBlack ? 'published frame is black: the face is not getting into the stream' : publisherStatus.error;
    send?.({
      type: 'studio_status',
      actor,
      publishing,
      ...(error && !publishing ? { error: error.slice(0, 300) } : {}),
      ...(micStatus ? { mic: { ...micStatus, ...(micStatus.error ? { error: micStatus.error.slice(0, 300) } : {}) } } : {}),
      ...(withCadence ? { cadence: withCadence } : {}),
      ...(devices ? { devices } : {}),
      // Whether the face worker runs at all, every couple of seconds: GET /studio/vision, the pulse, parts.
      ...(listener && options.face ? { faceWorker: options.face.debugStatus() } : {}),
    });
  }

  async function reportDevices(): Promise<void> {
    const media = navigator.mediaDevices;
    if (!listener || !config?.enabled || !media?.enumerateDevices) return;
    const probe = !devicesProbed;
    devicesProbed = true;
    try {
      const next = await readInputDevices(media, probe);
      if (JSON.stringify(next) === JSON.stringify(devices)) return;
      devices = next;
      reportStatus();
    } catch {
      // No device list here: the pick list offers the default only.
    }
  }
  const onDeviceChange = () => void reportDevices();

  /** Live state ~10 Hz while someone watches it, the camera a few times a second while someone shows it. */
  function syncWatchTimers(): void {
    const here = listener && Boolean(options.face) && Boolean(config?.enabled);
    const live = here && watch.live;
    const video = here && watch.video;
    if (live && !liveTimer) liveTimer = window.setInterval(sendLive, LIVE_REPORT_MS);
    if (!live && liveTimer) {
      window.clearInterval(liveTimer);
      liveTimer = 0;
      lastLiveKey = '';
      // The dashboards stop showing what no longer comes.
      if (liveSent) send?.({ type: 'studio_live', actor, status: null, speaking: false });
      liveSent = false;
    }
    if (video && !previewTimer) {
      lastPreviewKey = -1;
      previewTimer = window.setInterval(sendPreview, PREVIEW_FRAME_MS);
    }
    if (!video && previewTimer) {
      window.clearInterval(previewTimer);
      previewTimer = 0;
    }
  }

  function sendLive(): void {
    const status = liveStatusOf(store.getState());
    const speaking = options.voice?.headsTalking() ?? false;
    const faceWorker = options.face?.debugStatus();
    // Ages and rates change every report; what is shown changes with the rest.
    const key = JSON.stringify([status, speaking, faceWorker?.state, faceWorker?.detail, faceWorker?.lastCheckAt]);
    const now = Date.now();
    if (key === lastLiveKey && now - lastLiveSentAt < LIVE_KEEPALIVE_MS) return;
    lastLiveKey = key;
    lastLiveSentAt = now;
    liveSent = true;
    send?.({ type: 'studio_live', actor, status, speaking, ...(faceWorker ? { faceWorker } : {}) });
  }

  function sendPreview(): void {
    const picture = options.face?.previewFrame(PREVIEW_MAX_PX);
    if (!picture || picture.key === lastPreviewKey) return;
    lastPreviewKey = picture.key;
    send?.({ type: 'studio_frame', actor, frame: picture.frame, width: picture.width, height: picture.height });
  }

  /** A dashboard's onboarding, with this page's camera (it has none). */
  async function runFaceCall(message: WsStudioFaceCallServerMessage): Promise<void> {
    const face = options.face;
    try {
      if (!face) throw new Error('this studio page has no camera');
      const args = message.args ?? {};
      let value: unknown = null;
      window.clearTimeout(enrollIdleTimer);
      switch (message.method) {
        case 'beginEnrollment':
          face.beginEnrollment();
          break;
        case 'endEnrollment':
          face.endEnrollment();
          break;
        case 'captureEnrollmentSample':
          value = await face.captureEnrollmentSample(embeddingsOf(args.previous), boxOf(args.choose));
          break;
        case 'embedPicture': {
          const image = typeof args.image === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(args.image) && args.image.length <= MAX_PICTURE_CHARS ? args.image : null;
          value = image ? await face.embedPicture(await (await fetch(image)).blob()) : { ok: false, reason: 'not a JPEG, PNG or WebP picture (or too large)' };
          break;
        }
        case 'saveEnrollment':
          value = await face.saveEnrollment(typeof args.name === 'string' ? args.name : '', samplesOf(args.samples));
          break;
      }
      if (message.method === 'beginEnrollment' || message.method === 'captureEnrollmentSample') {
        // A dashboard that goes away mid-onboarding must not leave detection paused.
        enrollIdleTimer = window.setTimeout(() => face.endEnrollment(), ENROLLMENT_IDLE_MS);
      }
      send?.({ type: 'studio_face_result', id: message.id, ok: true, value });
    } catch (error) {
      send?.({ type: 'studio_face_result', id: message.id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    }
  }

  /**
   * What a line waits for before it plays: the turn's first line, for the face
   * to be in place (studio_stage; call-outs go at once); a line answering the
   * other head, for that head's line to have played out, plus a breath.
   */
  function lineGate(message: WsAudioChunkServerMessage): Promise<unknown> | null {
    if (message.callout) return null;
    const turnId = message.turnId ?? '';
    const waits: Array<Promise<unknown>> = [];
    if (!stagedTurns.has(turnId)) {
      stagedTurns.add(turnId);
      if (stagedTurns.size > 64) stagedTurns.delete(stagedTurns.values().next().value!);
      waits.push(stage.wait());
    }
    if (message.after && message.turnId) {
      waits.push(handover.waitFor({ actor: message.after.actor, turnId: message.turnId, text: message.after.text }));
    }
    return waits.length > 0 ? Promise.all(waits) : null;
  }

  /** Render cadence of the face plus what WebRTC made of it, every CADENCE_REPORT_MS. */
  async function reportCadence(): Promise<void> {
    const render = cadence.take(performance.now());
    const published = await publisher.stats().catch(() => null);
    const speech = takeStreamingAudioStats();
    reportStatus({
      renderFps: render.fps,
      renderMaxGapMs: render.maxGapMs,
      renderStalls: render.stalls,
      ...(published ?? {}),
      speechHoles: speech.underruns,
      speechMaxHoleMs: speech.maxUnderrunMs,
      speechHeldMs: Math.round(speech.heldMs),
      ...(speech.deliveryRate !== null ? { ttsRate: speech.deliveryRate } : {}),
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
    });
  }

  /** The voice goes into the stream (and to the speakers only as a monitor). */
  function routeVoice(): void {
    const context = options.speech.audioContext();
    const destination = context.createMediaStreamDestination();
    const out = context.createGain();
    out.connect(destination);
    if (options.monitor) out.connect(context.destination);
    // Keep the voice track running between lines. With nothing playing, Chrome
    // renders nothing into the destination and the track sends no packets;
    // each line then restarts the audio and receivers hold it back 1-2 s to
    // resync it with the video (lip sync and captions both lag).
    const silence = context.createConstantSource();
    silence.offset.value = 0;
    silence.connect(destination);
    silence.start();
    redirectSpeech((speechContext) => (speechContext === context ? out : speechContext.destination));
    voiceTrack = destination.stream.getAudioTracks()[0] ?? null;
    if (context.state !== 'running') {
      void context.resume().catch(() => {});
    }
  }

  /**
   * The published picture: the face as rendered, plus what the face window
   * shows over it as page text but a stream would lose. Today that is the
   * sleeping Zs (the app's .visual-zzz), drawn while the face is asleep. The
   * window shows this canvas too, so it shows what is published.
   */
  function composite(face: HTMLCanvasElement): HTMLCanvasElement | null {
    const host = options.root.querySelector<HTMLElement>('#visual-face');
    const canvas = document.createElement('canvas');
    canvas.width = options.canvasPx;
    canvas.height = options.canvasPx;
    canvas.id = 'studio-stream-canvas';
    canvas.className = 'studio-stream-canvas';
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!host || !ctx) return null;
    host.appendChild(canvas);
    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The app's typeface for the Zs; until it is loaded they draw in the fallback.
    let glyph: GlyphMetrics = DEFAULT_GLYPH;
    void document.fonts?.load('800 64px Outfit').then(() => {
      glyph = measureGlyph(ctx) ?? DEFAULT_GLYPH;
      zLayoutFor = null;
    }).catch(() => {});
    // Laid out once per face geometry: this head's own sleeping face.
    let zLayout: SleepZLayout | null = null;
    let zLayoutFor: SleepingFace | null = null;
    const started = performance.now();
    let lastFaceFrameAt = 0;
    const draw = (withFace: boolean) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (withFace) ctx.drawImage(face, 0, 0, canvas.width, canvas.height);
      const state = store.getState();
      // Laid out only when needed: the fit takes a moment, and face edits (FX editor) change the geometry often.
      const sleepingFace = state.sleeping ? options.glitch.sleepingFacePx() : null;
      if (sleepingFace && sleepingFace !== zLayoutFor) {
        zLayout = layoutSleepZs(sleepingFace, canvas.width, glyph);
        zLayoutFor = sleepingFace;
      }
      if (state.sleeping && zLayout) {
        // The head's own colour, as its face is drawn (glitch/runtime.ts syncConfig).
        const headColour = actor === 'small'
          ? (state.config?.secondaryGlitchFxBaseColor ?? state.config?.glitchFxBaseColor ?? null)
          : (state.config?.glitchFxBaseColor ?? null);
        drawSleepZs(ctx, (performance.now() - started) / 1000, zLayout, { reducedMotion, headColour });
      }
    };
    // The face is copied as each frame is drawn, the only moment a WebGPU
    // canvas can be read (a later copy is black in a windowed Chrome).
    options.glitch.setMaxFps(STUDIO_RENDER_MAX_FPS);
    options.glitch.onFrame(() => {
      lastFaceFrameAt = performance.now();
      cadence.frame(lastFaceFrameAt);
      draw(true);
    });
    // Every 2 s, a look at what is actually published: a tiny copy of the frame.
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 32;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    const blackMonitor = createBlackFrameMonitor();
    const probeTimer = window.setInterval(() => {
      if (!probeCtx) return;
      probeCtx.drawImage(canvas, 0, 0, probe.width, probe.height);
      const { data } = probeCtx.getImageData(0, 0, probe.width, probe.height);
      let brightest = 0;
      for (let i = 0; i < data.length; i += 4) brightest = Math.max(brightest, data[i]!, data[i + 1]!, data[i + 2]!);
      const black = blackMonitor.check(brightest);
      if (black !== frameBlack) {
        frameBlack = black;
        store.appendLog(black ? 'error' : 'info', black ? `Studio ${actor}: the published frame is black` : `Studio ${actor}: the face is back in the stream`);
        reportStatus();
      }
    }, 2000);
    // Without face frames (WebGPU down) the stream still runs, black plus Zs.
    let raf = 0;
    const idle = () => {
      raf = window.requestAnimationFrame(idle);
      if (performance.now() - lastFaceFrameAt > 250) draw(false);
    };
    raf = window.requestAnimationFrame(idle);
    stopCompositor = () => {
      window.clearInterval(probeTimer);
      options.glitch.onFrame(null);
      options.glitch.setMaxFps(0);
      window.cancelAnimationFrame(raf);
      canvas.remove();
    };
    return canvas;
  }

  /** Canvas video plus the voice, in one stream so receivers keep them in sync. */
  function faceStream(): MediaStream | null {
    if (stream?.getVideoTracks().some((track) => track.readyState === 'live')) return stream;
    const face = options.root.querySelector<HTMLCanvasElement>('#glitch-face-canvas');
    if (!face || !voiceTrack) return null;
    stopCompositor?.();
    const canvas = composite(face);
    if (!canvas) return null;
    const context = options.speech.audioContext();
    if (context.state !== 'running') {
      void context.resume().catch(() => {});
      store.appendLog('error', 'Studio: audio is suspended; start Chrome with --autoplay-policy=no-user-gesture-required');
    }
    const video = canvas.captureStream(CAPTURE_FPS).getVideoTracks()[0];
    if (!video) return null;
    // No 'detail' hint: Chrome encodes screen-like content in software, 15-25 ms a
    // frame here and more under load, which dropped frames; without it the
    // hardware encoder takes ~4 ms and keeps 1024 px (frameWidth in the cadence report).
    video.contentHint = '';
    stream = new MediaStream([video, voiceTrack]);
    return stream;
  }

  function applyConfig(next: WsStudioConfigServerMessage): void {
    config = next;
    // The site node's login, if it needs one (TUBS_STUDIO_SITE_AUTH); before publishing.
    setSiteLogin(next.siteAuth);
    publisher.publish(next.enabled ? `${next.site}/${next.streams[actor]}/whip` : null);
    // The switches (absent from an older server: all on); each leaves its source choice alone.
    const switches = next.switches ?? { camera: true, faceRecognition: true, mic: true };
    if (options.voice) {
      const source = next.enabled && switches.mic ? parseMicSource(next.micSource) : { kind: 'off' as const };
      if (source) {
        void options.voice.setMicSource(source, next.site);
      } else {
        store.appendLog('error', `Studio: unknown mic source ${next.micSource}`);
      }
    }
    if (options.face) {
      // Detection runs for recognition or for descriptions (a detected face triggers them).
      const detection = switches.faceRecognition || store.getState().config?.visionDescriptions !== false;
      options.face.setRecognition(switches.faceRecognition, detection);
      const source: VisionSourceSpec | null = next.enabled && switches.camera ? parseVisionSource(next.visionSource) : { kind: 'off' };
      if (!source) {
        store.appendLog('error', `Studio: unknown vision source ${next.visionSource}`);
      } else {
        const key = `${formatVisionSource(source)}@${source.kind === 'site' ? next.site : ''}`;
        // The models load only with a camera to look through and something to detect faces for.
        if (source.kind !== 'off' && detection && !faceStarted) {
          faceStarted = true;
          options.face.init();
        }
        if (key !== pictureSource) {
          pictureSource = key;
          void options.face.setPictureSource(source, next.site);
        }
      }
    }
    options.speech.setLineGate(next.enabled ? lineGate : null);
    if (next.enabled && !devices) void reportDevices();
    syncWatchTimers();
    if (next.enabled) startStateReports();
    else stopStateReports();
    // Also after a reconnect: the server forgot this page's status when its socket closed.
    reportStatus();
  }

  function sendState(force: boolean): void {
    const next = studioStateOf(store.getState());
    if (!force && !studioStateChanged(lastState, next)) return;
    lastState = next;
    send?.({ type: 'studio_state', actor, ...next, ts: Date.now() });
  }

  function startStateReports(): void {
    if (heartbeat) return;
    lastState = null;
    sendState(true);
    unsubscribeState = store.subscribeSelector(
      (state) => studioStateOf(state),
      () => sendState(false),
      { equalityFn: (a, b) => !studioStateChanged(a, b) },
    );
    // Captions follow this page's voice (it plays only this head) on its playback clock.
    const captions = createCaptionTracker();
    captionTimer = window.setInterval(() => {
      for (const caption of captions.update(readVoiceClock(), performance.now())) {
        send?.({ type: 'studio_caption', actor, ...caption, ts: Date.now() });
      }
    }, CAPTION_TICK_MS);
    let beats = 0;
    heartbeat = window.setInterval(() => {
      sendState(true);
      beats += 1;
      if (listener && options.face && beats % FACE_WORKER_REPORT_BEATS === 0) {
        reportStatus();
        // Also between checks (loading, off, stalled): the observation carries the worker's state.
        send?.({ type: 'face_observation', observation: options.face.observation() });
      }
      if (listener && presence.visitOver(Date.now())) {
        store.appendLog('info', 'Studio: nobody near either head for a while; the visit is over');
        send?.({ type: 'presence', present: false, count: 0 });
      }
    }, STUDIO_STATE_HEARTBEAT_MS);
    cadenceTimer = window.setInterval(() => void reportCadence(), CADENCE_REPORT_MS);
  }

  function stopStateReports(): void {
    window.clearInterval(heartbeat);
    heartbeat = 0;
    window.clearInterval(cadenceTimer);
    cadenceTimer = 0;
    window.clearInterval(captionTimer);
    captionTimer = 0;
    unsubscribeState?.();
    unsubscribeState = null;
  }

  return {
    init(nextSend) {
      send = nextSend;
      // Each check's faces, in the shape the face service sends (docs/face-service.md).
      if (listener) {
        options.face?.onObservation((observation) => {
          if (config?.enabled) send?.({ type: 'face_observation', observation });
        });
      }
      routeVoice();
      setBadge();
      window.addEventListener('pagehide', onPageHide);
      if (listener) navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    },
    handle(message) {
      switch (message.type) {
        case 'studio_config':
          applyConfig(message);
          return;
        case 'studio_look': {
          if (message.actor !== actor) return;
          const clamp = (value: number) => Math.max(-1, Math.min(1, value));
          // The director's y points up; the face's gaze y points down the screen.
          options.faceBehavior.setExternalLook(clamp(message.gaze[0]), -clamp(message.gaze[1]));
          return;
        }
        case 'studio_presence': {
          if (!listener) return;
          const count = presence.update(message.actor, message.present, message.people, Date.now());
          // With a studio camera, its own count of faces drives presence (it sees this window's visitors).
          const cameraOn = !pictureSource.startsWith('off');
          if (!cameraOn && count !== store.getState().faceLastDetectedCount) {
            store.setState((current) => ({ ...current, faceLastDetectedCount: count }));
          }
          return;
        }
        case 'studio_stage':
          if (message.actor === actor) stage.note(message.ready);
          return;
        case 'studio_caption':
          handover.noteCaption(message);
          return;
        case 'studio_state':
          handover.noteAlive(message.actor);
          return;
        case 'studio_watch':
          watch = { live: message.live, video: message.video };
          syncWatchTimers();
          return;
        case 'studio_face_call':
          void runFaceCall(message);
          return;
      }
    },
    noteMic(status) {
      micStatus = status;
      reportStatus();
    },
    dispose() {
      stage.dispose();
      handover.dispose();
      options.speech.setLineGate(null);
      window.removeEventListener('pagehide', onPageHide);
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      options.face?.onObservation(null);
      watch = { live: false, video: false };
      syncWatchTimers();
      window.clearTimeout(enrollIdleTimer);
      stopStateReports();
      publisher.dispose();
      for (const track of stream?.getVideoTracks() ?? []) track.stop();
      stopCompositor?.();
    },
  };
}

const MAX_SAMPLES = 10;
/** A photo to take a sample from (embedPicture), as a data URL. */
const MAX_PICTURE_CHARS = 12 * 1024 * 1024;

/** Which of several people to take (captureEnrollmentSample choose): [x, y, w, h] in 0..1, or nothing. */
export function boxOf(value: unknown): [number, number, number, number] | undefined {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= -0.5 && n <= 1.5)
    ? [value[0], value[1], value[2], value[3]]
    : undefined;
}
const MAX_EMBEDDING = 2048;
const isEmbedding = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.length <= MAX_EMBEDDING
  && value.every((n) => typeof n === 'number' && Number.isFinite(n));

/** A dashboard's earlier poses' embeddings (to spot a pose too like one taken). */
export function embeddingsOf(value: unknown): number[][] {
  return Array.isArray(value) ? value.filter(isEmbedding).slice(0, MAX_SAMPLES) : [];
}

/** The poses a dashboard kept, as the face library takes them. */
export function samplesOf(value: unknown): Array<{ embedding: number[]; thumbnail: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sample: unknown) => {
    if (typeof sample !== 'object' || sample === null) return [];
    const { embedding, thumbnail } = sample as { embedding?: unknown; thumbnail?: unknown };
    return isEmbedding(embedding) && typeof thumbnail === 'string' && thumbnail.startsWith('data:image/') && thumbnail.length <= 200_000
      ? [{ embedding, thumbnail }]
      : [];
  }).slice(0, MAX_SAMPLES);
}
