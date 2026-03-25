import type { Server as HttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type {
  WsAudioChunkServerMessage,
  WsClientMessage,
  WsConfigServerMessage,
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
import { runtimeConfig, sessionStats, toConfigResponse } from '../config/runtime.js';
import { interruptAssistantTurns, runAssistantTurn, runProactiveTurn } from '../assistant/service.js';
import { openTtsStream } from '../tts/stream.js';

const clients = new Set<WebSocket>();
const spectators = new Set<WebSocket>();
const WS_PATH = '/ws';

export function initWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

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
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
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

    socket.on('message', (raw: RawData) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (!isWsClientMessage(parsed)) {
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
  const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
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
      if (runtimeConfig.muted) {
        broadcast({ type: 'expression', expression: 'idle' });
        return;
      }
      broadcastInterrupt(interruptAssistantTurns(), 'user');
      sessionStats.messagesIn += 1;
      sessionStats.lastActivity = Date.now();
      broadcast({
        type: 'incoming',
        text: message.text,
      });
      broadcast({
        type: 'thinking',
      });
      void runAssistantTurn(message.text, broadcast).catch((error) => {
        console.error('[ws] assistant turn failed', error);
        broadcast({
          type: 'error',
          text: 'Response generation failed',
        });
      });
      return;
    case 'appearance_frame':
    case 'camera_frame':
      void import('../assistant/vision.js').then(m => m.processVisualContext(message.frame, message.type === 'camera_frame'));
      if (message.type === 'appearance_frame' && !runtimeConfig.muted) {
        broadcastInterrupt(interruptAssistantTurns(), 'system');
        sessionStats.messagesIn += 1;
        sessionStats.lastActivity = Date.now();
        const names = Array.isArray(message.faces)
          ? message.faces.map((name) => String(name || '').trim()).filter(Boolean)
          : [];
        const prompt = names.length > 0
          ? `Known person nearby: ${names.join(' and ')}. Greet them by name and make it impossible not to reply.`
          : 'Someone is nearby but has not spoken. Break the ice with something unexpected.';
        broadcast({ type: 'thinking' });
        void runProactiveTurn(prompt, broadcast).catch(console.error);
      }
      return;
    case 'face_greeting':
      if (runtimeConfig.muted) {
        return;
      }
      broadcastInterrupt(interruptAssistantTurns(), 'system');
      sessionStats.messagesIn += 1;
      sessionStats.lastActivity = Date.now();
      broadcast({ type: 'thinking' });
      void runProactiveTurn('Someone just appeared. Greet them in a way that gets an immediate response.', broadcast).catch(console.error);
      return;
    case 'proactive':
      if (runtimeConfig.muted || !message.context) {
        return;
      }
      broadcastInterrupt(interruptAssistantTurns(), 'system');
      sessionStats.messagesIn += 1;
      sessionStats.lastActivity = Date.now();
      broadcast({ type: 'thinking' });
      void runProactiveTurn(message.context, broadcast).catch(console.error);
      return;
    case 'interrupt':
      interruptAssistantTurns();
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
  const requestedAt = Date.now();

  console.log(`\x1b[36m[Streaming]\x1b[0m client TTS request received — text="${text.slice(0, 60)}" voice=${voice}${turnId ? ` turn=${turnId}` : ''}`);

  function sendSpeakEnd(): void {
    if (sentSpeakEnd) return;
    sentSpeakEnd = true;
    if (socket.readyState === socket.OPEN) {
      send(socket, {
        type: 'speak_end',
        ...(turnId ? { turnId } : {}),
      } satisfies WsSpeakEndServerMessage);
    }
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
    },
    onError(error) {
      console.warn(`\x1b[31m\x1b[1m[Streaming]\x1b[0m client TTS WS request error: ${error.message}`);
      // Ensure client gets speak_end even on error so it doesn't hang
      sendSpeakEnd();
    },
    onClose() {
      console.log(`\x1b[36m[Streaming]\x1b[0m client TTS request done — ${chunkIndex} chunks sent in ${Date.now() - requestedAt}ms${turnId ? ` (turn: ${turnId})` : ''}`);
      // Ensure speak_end is sent if TTS stream closed without onSentenceDone
      sendSpeakEnd();
    },
  });

  // Wait for connection, then send
  const waitAndSend = () => {
    if (ttsSession.ready) {
      ttsSession.send(text, voice);
      return;
    }
    if (ttsSession.closed) {
      console.warn(`\x1b[31m\x1b[1m[Streaming]\x1b[0m client TTS WS closed before ready — text "${text.slice(0, 40)}..."`);
      sendSpeakEnd();
      return;
    }
    setTimeout(waitAndSend, 10);
  };
  waitAndSend();
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
