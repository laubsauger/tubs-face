import type { Server as HttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type {
  WsAudioChunkServerMessage,
  WsClientMessage,
  WsConfigServerMessage,
  WsErrorServerMessage,
  WsFaceBlinkServerMessage,
  WsFaceMotionServerMessage,
  WsHeadSpeechStateServerMessage,
  WsInterruptServerMessage,
  WsPingServerMessage,
  WsServerMessage,
  WsSpeakEndServerMessage,
  WsStudioConfigServerMessage,
  WsStudioServerMessage,
  WsSystemServerMessage,
} from '../../shared/contracts/ws.js';
import type { StudioActor } from '../../shared/contracts/studio.js';
import { isWsClientMessage } from '../../shared/guards/index.js';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { runtimeConfig, toConfigResponse } from '../config/runtime.js';
import { interruptAssistantTurns } from '../assistant/service.js';
import { markLastReplyCutOff } from '../assistant/context.js';
import { fieldNotesSnapshot, onEnrollRequest, onFieldNotesChange, setPeople } from '../assistant/field-notes.js';
import { lookAtGalleryPictures } from '../studio/gallery-vision.js';
import { visionService } from '../assistant/vision.js';
import { appearancePrompt, cancelAppearanceGreeting, onNewVisitor, onVisitorLeft, scheduleAppearanceGreeting, startProactiveTurn, startUserTurn } from '../assistant/turns.js';
import { openTtsStream } from '../tts/stream.js';
import { notePageConnection, notePageStatus, studioConfigMessage, studioSettings } from '../studio/state.js';
import { siteLogin } from '../studio/site-auth.js';
import { noteStudioContext } from '../studio/context.js';
import { setLeadSink } from '../studio/lead.js';
import { forgetRecognised, noteRecognised } from '../assistant/relationships.js';
import { isRendering, onRenderingChange } from '../tts/rendering.js';
import { isLocalNetworkAddress } from '../memory/view.js';
import { forgetViewer, frameDue, liveGone, liveRelay, noteWatch, pulseLeaseEndsAt, serverFacesRelay, useServerFaces, wantedWatch, watchOf } from '../studio/live.js';
import { noteHeadSpeaking, studioPulse } from '../studio/pulse.js';
import type { FaceObservation } from '../../shared/contracts/studio.js';
import { bindRecognitionHooks, recognizer, serviceAutoEnroll, serviceFaceCall, serviceFaceWorker, serviceLiveFaces } from '../faces/studio-faces.js';
import type { ListenerEffect } from '../faces/recognition.js';
import { noteAudioSent, noteHeadSpeaking as noteHeadTalking } from '../assistant/heads.js';
import { forgetObservation, noteObservation } from '../studio/faces.js';

const clients = new Set<WebSocket>();
const spectators = new Set<WebSocket>();
/** Studio face pages (/ws?studio=main|small) and the actor each one shows. */
const studioPages = new Map<WebSocket, StudioActor>();
/** Pages that may watch the studio listener (studio_watch): the other pages on the local network. */
const liveViewers = new Set<WebSocket>();
/** What the listener was last told to send. */
let watchSent = { live: false, video: false };
let watchLeaseTimer: NodeJS.Timeout | null = null;
let lastPulsePushAt = 0;
const PULSE_PUSH_MIN_MS = 250;
/** Dashboards' studio_face_calls waiting for the listener's answer, by the id the listener sees. */
const faceCalls = new Map<string, { caller: WebSocket; id: string; at: number }>();
let faceCallSeq = 0;
const FACE_CALL_TIMEOUT_MS = 30_000;
/** The page whose camera last reported who is in view; its going away clears recognition. */
let recognitionSocket: WebSocket | null = null;
const WS_PATH = '/ws';


export function initWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  onFieldNotesChange(() => broadcast({ type: 'field_notes', ...fieldNotesSnapshot() }));
  onRenderingChange((rendering) => broadcast({ type: 'tts_rendering', rendering }));
  onEnrollRequest((personId, name) => {
    if (!runtimeConfig.autoEnrollEnabled) return;
    console.log(`[faces] auto onboarding: enrolling ${name}`);
    // The face service's snapshots are on the server; the browser worker's on the listener page.
    if (recognizer() === 'service') void serviceAutoEnroll(personId, name);
    else broadcast({ type: 'enroll_request', personId, name });
  });
  bindRecognitionHooks({
    apply: applyListenerMessage,
    publish: publishObservation,
    facesChanged: () => broadcast({ type: 'faces_changed' }),
  });
  useServerFaces(serviceLiveFaces, serviceFaceWorker);

  server.on('upgrade', (request, socket, head) => {
    if (!isWebSocketRequest(request)) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const isSpectator = url.searchParams.get('role') === 'spectator';
    const studioParam = url.searchParams.get('studio');
    const studioActor: StudioActor | null = studioParam === 'main' || studioParam === 'small' ? studioParam : null;

    clients.add(socket);
    if (isSpectator) {
      spectators.add(socket);
    }
    if (studioActor) {
      studioPages.set(socket, studioActor);
      notePageConnection(studioActor, true);
    } else if (isLocalNetworkAddress(request.socket.remoteAddress)) {
      // The dashboard connects as a spectator.
      liveViewers.add(socket);
    }

    send(socket, {
      type: 'config',
      ...toConfigResponse(),
    } satisfies WsConfigServerMessage);

    send(socket, {
      type: 'system',
      text: isSpectator ? 'Connected as spectator' : 'Connected to Tubs Bridge Server',
    } satisfies WsSystemServerMessage);
    send(socket, { type: 'field_notes', ...fieldNotesSnapshot() });
    // Face pages always learn the studio settings. Other pages only while studio
    // mode is on (the operator face then leaves the mic to the studio listener);
    // with it off they get nothing new.
    if (studioActor || studioSettings.enabled) {
      send(socket, studioActor ? withSiteLogin(studioConfigMessage()) : studioConfigMessage());
    }
    // The listener sends only what someone watches; it starts out watched by nobody.
    if (studioActor === 'main') {
      const wanted = wantedWatch();
      if (wanted.live || wanted.video) send(socket, wanted);
    }
    if (isRendering()) send(socket, { type: 'tts_rendering', rendering: true });

    socket.on('message', (raw: RawData) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (!isWsClientMessage(parsed)) {
          const type = typeof parsed === 'object' && parsed !== null ? String((parsed as { type?: unknown }).type) : typeof parsed;
          console.warn(`[ws] dropped invalid ${type} message`);
          return;
        }

        // Spectators (the dashboard among them) can only send pings, and say what of the studio listener they watch
        if (isSpectator && parsed.type !== 'ping' && parsed.type !== 'studio_watch' && parsed.type !== 'studio_face_call') {
          return;
        }

        handleClientMessage(socket, parsed);
      } catch (error) {
        console.error('[ws] bad message', error);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      spectators.delete(socket);
      if (liveViewers.delete(socket)) {
        forgetViewer(socket);
        syncStudioWatch();
      }
      if (socket === recognitionSocket) {
        recognitionSocket = null;
        forgetRecognised();
      }
      if (studioActor) {
        studioPages.delete(socket);
        if (![...studioPages.values()].includes(studioActor)) {
          notePageConnection(studioActor, false);
          if (studioActor === 'main') {
            // The browser producer's observation goes with its page; the face service's does not.
            if (recognizer() !== 'service') forgetObservation();
            sendToWatchers(liveGone(), 'live');
            failFaceCalls('the studio listener page went away');
          }
        }
      }
    });
  });

  return wss;
}

function isWebSocketRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  return pathname === WS_PATH;
}

// the heads' decision to lead the tour on goes to the director (and every page)
setLeadSink(() => broadcast({ type: 'studio_lead', to: 'next', ts: Date.now() }));

export function broadcast(message: WsServerMessage): void {
  if (message.type === 'audio_chunk') noteAudioSent();
  const payload = JSON.stringify(message);
  // The site login goes to the studio face pages only (studio/site-auth.ts).
  const pagePayload = message.type === 'studio_config' ? JSON.stringify(withSiteLogin(message)) : payload;
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(studioPages.has(client) ? pagePayload : payload);
    } else if (client.readyState > client.OPEN) {
      clients.delete(client);
    }
  }
}

export function broadcastConfig(): void {
  broadcast({
    type: 'config',
    ...toConfigResponse(),
  });
}

/** studio_look and studio_presence are for the face pages only. */
function sendToStudioPages(message: WsStudioServerMessage): void {
  const payload = JSON.stringify(message);
  for (const page of studioPages.keys()) {
    if (page.readyState === page.OPEN) page.send(payload);
  }
}

/** To the dashboards that watch the listener's live state, or its camera. */
function sendToWatchers(message: WsServerMessage, what: 'live' | 'video'): void {
  const payload = JSON.stringify(message);
  for (const viewer of liveViewers) {
    if (watchOf(viewer)?.[what] && viewer.readyState === viewer.OPEN) viewer.send(payload);
  }
}

function listenerPages(): WebSocket[] {
  return [...studioPages.entries()].filter(([, actor]) => actor === 'main').map(([page]) => page);
}

/**
 * Tells the listener page what to send when that changes: its live state while
 * a dashboard watches or someone polls GET /studio/pulse, its camera while a
 * dashboard shows it. Called on every watch change and pulse poll.
 */
export function syncStudioWatch(now = Date.now()): void {
  const wanted = wantedWatch(now);
  if (wanted.live !== watchSent.live || wanted.video !== watchSent.video) {
    watchSent = { live: wanted.live, video: wanted.video };
    for (const page of listenerPages()) send(page, wanted);
  }
  // A pulse poll's lease runs out without anyone saying so: look again then.
  if (watchLeaseTimer) clearTimeout(watchLeaseTimer);
  watchLeaseTimer = null;
  const leaseLeft = pulseLeaseEndsAt() - now;
  if (leaseLeft > 0) {
    watchLeaseTimer = setTimeout(() => syncStudioWatch(), leaseLeft + 10);
    watchLeaseTimer.unref();
  }
}

/**
 * A frame's faces, from the face service: to the listener page (its sleep and
 * proactive lines follow who is in view) and the dashboards watching the studio,
 * with the studio_live relay and the pulse they show.
 */
function publishObservation(observation: FaceObservation): void {
  noteObservation(observation);
  const payload = JSON.stringify({ type: 'face_observation', observation });
  for (const page of listenerPages()) {
    if (page.readyState === page.OPEN) page.send(payload);
  }
  for (const viewer of liveViewers) {
    if (watchOf(viewer)?.live && viewer.readyState === viewer.OPEN) viewer.send(payload);
  }
  const relay = serverFacesRelay();
  if (relay) {
    sendToWatchers(relay, 'live');
    pushPulse();
  }
}

function pushPulse(force = false): void {
  const now = Date.now();
  const watching = [...liveViewers].some((viewer) => watchOf(viewer)?.live);
  if (watching && (now - lastPulsePushAt >= PULSE_PUSH_MIN_MS || force)) {
    lastPulsePushAt = now;
    sendToWatchers({ type: 'studio_pulse', pulse: studioPulse(now) }, 'live');
  }
}

/**
 * What the server does with the listener page's recognition messages; the face
 * service's frames come here too (faces/recognition.ts), as if a page had sent them.
 */
export function applyListenerMessage(message: ListenerEffect): void {
  switch (message.type) {
    case 'appearance_frame':
    case 'camera_frame':
      // A new visitor is looked at at once; a camera_frame is the periodic refresh (budgeted, docs/vision.md).
      void import('../assistant/vision.js').then(m => m.processVisualContext(message.frame, message.type === 'appearance_frame' ? 'appearance' : 'refresh'));
      if (message.type === 'appearance_frame' && !runtimeConfig.muted) {
        const names = Array.isArray(message.faces)
          ? message.faces.map((name) => String(name || '').trim()).filter(Boolean)
          : [];
        scheduleAppearanceGreeting(appearancePrompt(names, message.returning === true, message.awayMs), broadcast);
      }
      return;
    case 'proactive':
      startProactiveTurn(message.context ?? '', broadcast);
      return;
    case 'people':
      setPeople(message.people);
      noteRecognised(message.people);
      return;
    case 'presence':
      if (!message.present) onVisitorLeft();
      else if (message.newVisitor) onNewVisitor();
      return;
  }
}

function failFaceCalls(error: string): void {
  for (const [key, call] of faceCalls) {
    send(call.caller, { type: 'studio_face_result', id: call.id, ok: false, error });
    faceCalls.delete(key);
  }
}

export function getClientCount(): number {
  return clients.size;
}

export function getSpectatorCount(): number {
  return spectators.size;
}

function handleClientMessage(socket: WebSocket, message: WsClientMessage): void {
  switch (message.type) {
    case 'ping':
      send(socket, {
        type: 'ping',
        ts: message.ts,
        serverTs: Date.now(),
      } satisfies WsPingServerMessage);
      return;
    case 'incoming':
      void startUserTurn({ text: message.text, source: 'text', broadcast })?.catch(() => {
        // Already logged and broadcast as an error by startUserTurn.
      });
      return;
    case 'appearance_frame':
    case 'camera_frame':
    case 'people':
      // While the face service recognises, a page's own face worker (one left running) must not count twice.
      if (recognizer() === 'service') return;
      if (message.type === 'people') recognitionSocket = socket;
      applyListenerMessage(message);
      return;
    case 'proactive':
    case 'presence':
      applyListenerMessage(message);
      return;
    case 'interrupt':
      // The face sends this when a visitor starts talking over Tubs.
      cancelAppearanceGreeting();
      interruptAssistantTurns();
      markLastReplyCutOff();
      broadcastInterrupt(message.turnId ?? null, 'user');
      return;
    case 'face_motion':
      broadcast({
        type: 'face_motion',
        actor: message.actor,
        x: message.x,
        y: message.y,
        ts: message.ts ?? Date.now(),
      } satisfies WsFaceMotionServerMessage);
      return;
    case 'face_blink':
      broadcast({
        type: 'face_blink',
        actor: message.actor,
        ts: message.ts ?? Date.now(),
      } satisfies WsFaceBlinkServerMessage);
      return;
    case 'head_speech_state':
      // A face window's head talking (outside studio mode): proactive lines wait for it.
      if (!studioSettings.enabled) noteHeadTalking(message.actor ?? 'main', message.state === 'start');
      broadcast({
        type: 'head_speech_state',
        actor: message.actor,
        state: message.state,
        ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
        ts: message.ts ?? Date.now(),
        ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
      } satisfies WsHeadSpeechStateServerMessage);
      return;
    case 'tts_request':
      handleTtsStreamRequest(socket, message);
      return;
    // Studio mode (sentient-studio contract section 6). Off, they change nothing.
    case 'studio_look':
      if (!studioSettings.enabled) return;
      sendToStudioPages({ type: 'studio_look', actor: message.actor, gaze: message.gaze });
      return;
    case 'studio_presence':
      if (!studioSettings.enabled) return;
      sendToStudioPages({
        type: 'studio_presence',
        actor: message.actor,
        present: message.present,
        ...(message.people !== undefined ? { people: message.people } : {}),
      });
      return;
    case 'studio_state':
      if (!studioSettings.enabled || !studioPages.has(socket)) return;
      if (studioPages.get(socket) === message.actor) noteHeadSpeaking(message.actor, message.speaking);
      broadcast({ type: 'studio_state', actor: message.actor, speaking: message.speaking, expr: message.expr, mood: message.mood, ts: message.ts });
      return;
    case 'studio_stage':
      // The director's "this head is in place" for the face pages; studio mode only.
      if (!studioSettings.enabled || studioPages.has(socket) || spectators.has(socket)) return;
      sendToStudioPages({ type: 'studio_stage', actor: message.actor, ready: message.ready });
      return;
    case 'studio_context':
      // From the director only (not a face page, not a spectator), and only in studio mode.
      if (!studioSettings.enabled || studioPages.has(socket) || spectators.has(socket)) return;
      noteStudioContext({
        reason: message.reason,
        heads: message.heads,
        people: message.people.map((person) => ({ ...person, with: person.with ?? null })),
        reference: message.reference ?? null,
        ...(message.venue ? { venue: message.venue } : {}),
        // the gallery tour: without it here the picture on screen never reached the prompt
        ...(message.tour && typeof message.tour.where === 'string' ? { tour: message.tour } : {}),
        // the screening: the shot on every screen
        ...(message.screening && typeof message.screening.film === 'string' ? { screening: message.screening } : {}),
        ...(message.gallery && Array.isArray(message.gallery.showing) ? { gallery: message.gallery } : {}),
        ts: message.ts,
      });
      // vision on: the heads take their own look at the picture pulled up and the ones where they stand
      lookAtGalleryPictures([
        ...(message.tour?.piece ? [message.tour.piece] : []),
        ...(message.gallery?.showing ?? []).filter((w) => w.here).flatMap((w) => w.pictures),
      ], { describe: (dataUrl, ask) => visionService.describe(dataUrl, ask), fetch, now: Date.now });
      return;
    case 'studio_caption':
      // Only from the page that plays this head's voice: its clock is the stream's.
      if (!studioSettings.enabled || studioPages.get(socket) !== message.actor) return;
      broadcast({
        type: 'studio_caption',
        actor: message.actor,
        turnId: message.turnId,
        text: message.text,
        spoken: message.spoken,
        done: message.done,
        ts: message.ts,
      });
      return;
    case 'studio_live': {
      // The listener (main) only; a stop goes through even after studio mode went off.
      if (message.actor !== 'main' || studioPages.get(socket) !== 'main') return;
      if (!studioSettings.enabled && message.status !== null) return;
      const relay = liveRelay(message);
      if (!relay) return;
      sendToWatchers(relay, 'live');
      pushPulse(!message.status);
      return;
    }
    case 'face_observation':
      // The browser producer: the studio listener page only, and not while the face service recognises (docs/face-service.md).
      if (studioPages.get(socket) !== 'main' || message.observation.worker.kind !== 'browser' || recognizer() === 'service') return;
      noteObservation(message.observation);
      sendToWatchers({ type: 'face_observation', observation: message.observation }, 'live');
      return;
    case 'studio_watch':
      if (!liveViewers.has(socket)) return;
      noteWatch(socket, { live: message.live, video: message.video });
      syncStudioWatch();
      return;
    case 'studio_frame':
      if (message.actor !== 'main' || studioPages.get(socket) !== 'main' || !studioSettings.enabled) return;
      if (frameDue()) sendToWatchers({ type: 'studio_frame', actor: 'main', frame: message.frame, width: message.width, height: message.height }, 'video');
      return;
    case 'studio_face_call': {
      // A dashboard on the local network asks the listener's face runtime (onboarding with its camera).
      if (!liveViewers.has(socket)) return;
      if (recognizer() === 'service') {
        // The face service has the camera: the server answers, as the listener page would.
        void serviceFaceCall(message.method, message.args ?? {}).then(
          (value) => send(socket, { type: 'studio_face_result', id: message.id, ok: true, value: value ?? null }),
          (error: unknown) => send(socket, { type: 'studio_face_result', id: message.id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }),
        );
        return;
      }
      const listener = listenerPages()[0];
      if (!studioSettings.enabled || !listener) {
        send(socket, { type: 'studio_face_result', id: message.id, ok: false, error: 'the studio listener page is not connected' });
        return;
      }
      const now = Date.now();
      for (const [key, call] of faceCalls) {
        if (now - call.at > FACE_CALL_TIMEOUT_MS) faceCalls.delete(key);
      }
      faceCallSeq += 1;
      const key = `c${faceCallSeq}`;
      faceCalls.set(key, { caller: socket, id: message.id, at: now });
      send(listener, { type: 'studio_face_call', id: key, method: message.method, ...(message.args ? { args: message.args } : {}) });
      return;
    }
    case 'studio_face_result': {
      if (studioPages.get(socket) !== 'main') return;
      const call = faceCalls.get(message.id);
      if (!call) return;
      faceCalls.delete(message.id);
      send(call.caller, { type: 'studio_face_result', id: call.id, ok: message.ok, ...(message.value !== undefined ? { value: message.value } : {}), ...(message.error ? { error: message.error } : {}) });
      return;
    }
    case 'studio_status':
      if (studioPages.get(socket) !== message.actor) return;
      notePageStatus(message.actor, {
        publishing: message.publishing,
        ...(message.error ? { error: message.error } : {}),
        ...(message.mic ? { mic: message.mic } : {}),
        ...(message.cadence ? { cadence: message.cadence } : {}),
        ...(message.devices ? { devices: message.devices } : {}),
        ...(message.faceWorker ? { faceWorker: message.faceWorker } : {}),
      });
      return;
    default:
      return;
  }
}

function broadcastInterrupt(turnId?: string | null, source?: WsInterruptServerMessage['source']): void {
  broadcast({
    type: 'interrupt',
    ...(turnId !== undefined ? { turnId } : {}),
    ...(source ? { source } : {}),
  } satisfies WsInterruptServerMessage);
}

function handleTtsStreamRequest(socket: WebSocket, message: Extract<WsClientMessage, { type: 'tts_request' }>): void {
  const text = String(message.text || '').trim();
  if (!text) return;

  const turnId = message.turnId;
  const voice = message.voice || runtimeConfig.kokoroVoice || 'af_heart';
  let chunkIndex = 0;
  let sentSpeakEnd = false;
  let sentError = false;
  const requestedAt = Date.now();

  console.log(`\x1b[36m[Streaming]\x1b[0m client TTS request received — text="${text.slice(0, 60)}" voice=${voice}${turnId ? ` turn=${turnId}` : ''}`);

  function sendSpeakEnd(): void {
    if (sentSpeakEnd) return;
    sentSpeakEnd = true;
    if (socket.readyState === socket.OPEN) {
      send(socket, {
        type: 'speak_end',
        text,
        fullText: text,
        ...(turnId ? { turnId } : {}),
      } satisfies WsSpeakEndServerMessage);
    }
  }

  function sendTtsError(reason: string): void {
    if (sentError) {
      return;
    }
    sentError = true;
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    send(socket, {
      type: 'error',
      text: `Streaming TTS unavailable: ${reason}`,
    } satisfies WsErrorServerMessage);
  }

  const ttsSession = openTtsStream({
    onChunk(chunk) {
      if (socket.readyState !== socket.OPEN) {
        ttsSession.close();
        return;
      }
      if (chunkIndex === 0) {
        console.log(`\x1b[36m[Streaming]\x1b[0m first audio chunk ready in ${Date.now() - requestedAt}ms${turnId ? ` (turn: ${turnId})` : ''}`);
      }
      send(socket, {
        type: 'audio_chunk',
        audio: chunk.audio,
        text: chunk.text || text,
        ...(turnId ? { turnId } : {}),
        chunkIndex: chunkIndex++,
        ...(chunk.more ? { more: true } : {}),
      } satisfies WsAudioChunkServerMessage);
    },
    onSentenceDone() {
      sendSpeakEnd();
      ttsSession.close();
    },
    onError(error) {
      console.warn(`\x1b[31m\x1b[1m[Streaming]\x1b[0m client TTS WS request error: ${error.message}`);
      if (chunkIndex === 0) {
        sendTtsError(error.message);
        sendSpeakEnd();
        return;
      }
      sendSpeakEnd();
    },
    onClose() {
      console.log(`\x1b[36m[Streaming]\x1b[0m client TTS request done — ${chunkIndex} chunks sent in ${Date.now() - requestedAt}ms${turnId ? ` (turn: ${turnId})` : ''}`);
      if (chunkIndex === 0 && !sentSpeakEnd) {
        sendTtsError('stream closed before audio');
      }
      sendSpeakEnd();
    },
  });

  void ttsSession.opened.then((ok) => {
    if (ok && ttsSession.ready) {
      ttsSession.send(text, voice);
      return;
    }
    console.warn(`\x1b[31m\x1b[1m[Streaming]\x1b[0m client TTS WS closed before ready — text "${text.slice(0, 40)}..."`);
    if (chunkIndex === 0) {
      sendTtsError('stream closed before ready');
    }
    sendSpeakEnd();
  });
  // Safety timeout
  setTimeout(() => {
    if (!ttsSession.closed) {
      ttsSession.close();
    }
  }, 30_000);
}

function withSiteLogin(message: WsStudioConfigServerMessage): WsStudioConfigServerMessage {
  const login = siteLogin();
  return login.publish || login.read ? { ...message, siteAuth: login } : message;
}

function send(socket: WebSocket, message: WsServerMessage): void {
  socket.send(JSON.stringify(message));
}
