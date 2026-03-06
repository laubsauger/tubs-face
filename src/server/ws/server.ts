import type { Server as HttpServer } from 'node:http';
import type { WsClientMessage, WsConfigServerMessage, WsPingServerMessage, WsServerMessage, WsSystemServerMessage } from '../../shared/contracts/ws.js';
import { isWsClientMessage } from '../../shared/guards/index.js';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { runtimeConfig, sessionStats, toConfigResponse } from '../config/runtime.js';
import { runAssistantTurn } from '../assistant/service.js';

const clients = new Set<WebSocket>();

export function initWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket: WebSocket) => {
    clients.add(socket);

    send(socket, {
      type: 'config',
      ...toConfigResponse(),
    } satisfies WsConfigServerMessage);

    send(socket, {
      type: 'system',
      text: 'Connected to Tubs Bridge Server',
    } satisfies WsSystemServerMessage);

    socket.on('message', (raw: RawData) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (!isWsClientMessage(parsed)) {
          return;
        }

        handleClientMessage(socket, parsed);
      } catch (error) {
        console.error('[ws] bad message', error);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  return wss;
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
    default:
      return;
  }
}

function send(socket: WebSocket, message: WsServerMessage): void {
  socket.send(JSON.stringify(message));
}
