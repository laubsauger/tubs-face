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
  WsSystemServerMessage,
} from '../../shared/contracts/ws.js';
import { isWsClientMessage } from '../../shared/guards/index.js';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { runtimeConfig, toConfigResponse } from '../config/runtime.js';
import { interruptAssistantTurns } from '../assistant/service.js';
import { markLastReplyCutOff } from '../assistant/context.js';
import { fieldNotesSnapshot, onFieldNotesChange, setCurrentVisitor } from '../assistant/field-notes.js';
import { appearancePrompt, cancelAppearanceGreeting, onNewVisitor, onVisitorLeft, scheduleAppearanceGreeting, startProactiveTurn, startUserTurn } from '../assistant/turns.js';
import { openTtsStream } from '../tts/stream.js';

const clients = new Set<WebSocket>();
const spectators = new Set<WebSocket>();
const WS_PATH = '/ws';


export function initWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  onFieldNotesChange(() => broadcast({ type: 'field_notes', ...fieldNotesSnapshot() }));

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

    clients.add(socket);
    if (isSpectator) {
      spectators.add(socket);
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
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
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
      void import('../assistant/vision.js').then(m => m.processVisualContext(message.frame));
      if (message.type === 'appearance_frame' && !runtimeConfig.muted) {
        const names = Array.isArray(message.faces)
          ? message.faces.map((name) => String(name || '').trim()).filter(Boolean)
          : [];
        if (message.visitorId) setCurrentVisitor(message.visitorId, names);
        scheduleAppearanceGreeting(appearancePrompt(names, message.returning === true, message.awayMs), broadcast);
      }
      return;
    case 'proactive':
      startProactiveTurn(message.context ?? '', broadcast);
      return;
    case 'presence':
      if (!message.present) onVisitorLeft();
      else if (message.newVisitor) onNewVisitor(message.visitorId, message.faces ?? []);
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

function send(socket: WebSocket, message: WsServerMessage): void {
  socket.send(JSON.stringify(message));
}
