import type { WsClientMessage, WsPingClientMessage, WsServerMessage } from '../../shared/contracts/ws.js';
import { isWsServerMessage } from '../../shared/guards/index.js';

export interface WsClientOptions {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage: (message: WsServerMessage) => void;
  onError?: (error: Event) => void;
}

export interface ManagedWsClient {
  connect(): void;
  disconnect(): void;
  send(message: WsClientMessage): void;
}

const PING_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

export function createManagedWsClient(options: WsClientOptions): ManagedWsClient {
  let socket: WebSocket | null = null;
  let pingTimer: number | null = null;
  let reconnectTimer: number | null = null;

  function connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${window.location.host}`);

    socket.addEventListener('open', () => {
      options.onOpen?.();
      startPing();
    });

    socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data));
        if (!isWsServerMessage(parsed)) {
          return;
        }
        options.onMessage(parsed);
      } catch {
        // ignore malformed payloads in scaffold stage
      }
    });

    socket.addEventListener('close', () => {
      stopPing();
      options.onClose?.();
      reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
    });

    socket.addEventListener('error', (event) => {
      options.onError?.(event);
      socket?.close();
    });
  }

  function disconnect(): void {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopPing();
    socket?.close();
    socket = null;
  }

  function send(message: WsClientMessage): void {
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function startPing(): void {
    stopPing();
    pingTimer = window.setInterval(() => {
      const ping: WsPingClientMessage = {
        type: 'ping',
        ts: Date.now(),
      };
      send(ping);
    }, PING_INTERVAL_MS);
  }

  function stopPing(): void {
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  return { connect, disconnect, send };
}
