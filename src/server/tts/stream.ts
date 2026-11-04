import { WebSocket } from 'ws';
import { getTtsProxyTarget } from '../processing/speech-service.js';

export interface TtsStreamChunk {
  text: string;
  audio: string;
  /** More audio for the same text follows (Ming streams one reply in several chunks). */
  more?: boolean;
}

export interface TtsStreamSession {
  /** Resolves true once the socket is open, false if it closes or errors first. */
  readonly opened: Promise<boolean>;
  send(text: string, voice: string): void;
  close(): void;
  readonly ready: boolean;
  readonly closed: boolean;
}

/**
 * Opens a WebSocket to the Python TTS streaming endpoint.
 * Each `send()` queues text for TTS. The Python side generates audio
 * in chunks and sends them back. `onChunk` fires for each audio chunk.
 * `onSentenceDone` fires when a full sentence's audio is complete.
 */
export function openTtsStream(options: {
  onChunk: (chunk: TtsStreamChunk) => void;
  onSentenceDone: () => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}): TtsStreamSession {
  const target = getTtsProxyTarget();
  const url = `ws://${target.hostname}:${target.port}/tts/stream`;
  let ready = false;
  let closed = false;
  let settleOpened!: (ok: boolean) => void;
  const opened = new Promise<boolean>((resolve) => {
    settleOpened = resolve;
  });

  const ws = new WebSocket(url);

  ws.on('open', () => {
    ready = true;
    settleOpened(true);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        error?: string;
        chunk?: boolean;
        audio?: string;
        text?: string;
        more?: boolean;
        done?: boolean;
      };

      if (msg.error) {
        options.onError?.(new Error(`TTS stream: ${msg.error}`));
        return;
      }

      if (msg.chunk && msg.audio) {
        options.onChunk({
          text: msg.text ?? '',
          audio: msg.audio,
          ...(msg.more ? { more: true } : {}),
        });
      }

      if (msg.done) {
        options.onSentenceDone();
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('error', (error) => {
    ready = false;
    settleOpened(false);
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  ws.on('close', () => {
    ready = false;
    closed = true;
    settleOpened(false);
    options.onClose?.();
  });

  return {
    opened,
    send(text: string, voice: string): void {
      if (ready && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text, voice }));
      }
    },
    close(): void {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      closed = true;
      settleOpened(false);
    },
    get ready() {
      return ready && ws.readyState === WebSocket.OPEN;
    },
    get closed() {
      return closed;
    },
  };
}
