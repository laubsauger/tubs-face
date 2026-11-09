// A studio face page (studio-face.html?actor=main|small): one head, rendered
// alone on black and published to the site node with its voice, gaze and
// presence from the director. sentient-studio docs/contract.md, sections 5-6.
//
// The main page is also the listener (mic, speech-to-text, sleep and
// proactive lines), the job the operator face does outside the studio: it
// already plays main's voice and hears small's speech state from the server,
// which is all the echo guard needs, and the studio needs no third page.

import { formatVisionSource, parseMicSource, parseVisionSource, type StudioActor, type StudioCadence, type StudioMicStatus, type VisionSourceSpec } from '../../shared/contracts/studio.js';
import type { WsAudioChunkServerMessage, WsClientMessage, WsStudioConfigServerMessage, WsStudioServerMessage } from '../../shared/contracts/ws.js';
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
import { createCadenceMeter } from './cadence.js';
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
    });
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
    publisher.publish(next.enabled ? `${next.site}/${next.streams[actor]}/whip` : null);
    if (options.voice) {
      const source = next.enabled ? parseMicSource(next.micSource) : { kind: 'off' as const };
      if (source) {
        void options.voice.setMicSource(source, next.site);
      } else {
        store.appendLog('error', `Studio: unknown mic source ${next.micSource}`);
      }
    }
    if (options.face) {
      const source: VisionSourceSpec | null = next.enabled ? parseVisionSource(next.visionSource) : { kind: 'off' };
      if (!source) {
        store.appendLog('error', `Studio: unknown vision source ${next.visionSource}`);
      } else {
        const key = `${formatVisionSource(source)}@${source.kind === 'site' ? next.site : ''}`;
        if (key !== pictureSource) {
          pictureSource = key;
          if (source.kind !== 'off' && !faceStarted) {
            // The detector loads its models only once there is a camera to look through.
            faceStarted = true;
            options.face.init();
          }
          void options.face.setPictureSource(source, next.site);
        }
      }
    }
    options.speech.setLineGate(next.enabled ? lineGate : null);
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
    heartbeat = window.setInterval(() => {
      sendState(true);
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
      routeVoice();
      setBadge();
      window.addEventListener('pagehide', onPageHide);
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
      stopStateReports();
      publisher.dispose();
      for (const track of stream?.getVideoTracks() ?? []) track.stop();
      stopCompositor?.();
    },
  };
}
