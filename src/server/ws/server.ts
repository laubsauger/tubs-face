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
import { appearancePrompt, cancelAppearanceGreeting, onNewVisitor, onVisitorLeft, scheduleAppearanceGreeting, startProactiveTurn, startUserTurn } from '../assistant/turns.js';
import { openTtsStream } from '../tts/stream.js';
import { notePageConnection, notePageStatus, studioConfigMessage, studioSettings } from '../studio/state.js';
import { siteLogin } from '../studio/site-auth.js';
import { noteStudioContext } from '../studio/context.js';
import { forgetRecognised, noteRecognised } from '../assistant/relationships.js';
import { isRendering, onRenderingChange } from '../tts/rendering.js';

const clients = new Set<WebSocket>();
const spectators = new Set<WebSocket>();
/** Studio face pages (/ws?studio=main|small) and the actor each one shows. */
const studioPages = new Map<WebSocket, StudioActor>();
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
    broadcast({ type: 'enroll_request', personId, name });
  });

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
    if (isRendering()) send(socket, { type: 'tts_rendering', rendering: true });

    socket.on('message', (raw: RawData) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (!isWsClientMessage(parsed)) {
          const type = typeof parsed === 'object' && parsed !== null ? String((parsed as { type?: unknown }).type) : typeof parsed;
          console.warn(`[ws] dropped invalid ${type} message`);
          return;
        }

        // Spectators can only send pings
        if (isSpectator && parsed.type !== 'ping') {
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
      if (socket === recognitionSocket) {
        recognitionSocket = null;
        forgetRecognised();
      }
      if (studioActor) {
        studioPages.delete(socket);
        if (![...studioPages.values()].includes(studioActor)) notePageConnection(studioActor, false);
      }
    });
  });

  return wss;
}

function isWebSocketRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  return pathname === WS_PATH;
}

export function broadcast(message: WsServerMessage): void {
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
      recognitionSocket = socket;
      noteRecognised(message.people);
      return;
    case 'presence':
      if (!message.present) onVisitorLeft();
      else if (message.newVisitor) onNewVisitor();
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
        ts: message.ts,
      });
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
    case 'studio_status':
      if (studioPages.get(socket) !== message.actor) return;
      notePageStatus(message.actor, {
        publishing: message.publishing,
        ...(message.error ? { error: message.error } : {}),
        ...(message.mic ? { mic: message.mic } : {}),
        ...(message.cadence ? { cadence: message.cadence } : {}),
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
