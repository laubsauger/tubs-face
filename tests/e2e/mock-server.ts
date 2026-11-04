/**
 * Stand-in for the Tubs server in browser tests. Serves the boot endpoints with
 * the real default config, accepts the face's WebSocket, and lets a test:
 *   POST /__test/send       broadcast scripted server messages to the page
 *   GET  /__test/received   read what the page sent (WS messages and HTTP posts)
 *   POST /__test/reset      clear that record
 *   GET  /__test/clients    how many pages are connected
 * tts_request messages are answered with tone audio, like the Python TTS would.
 */
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { toConfigResponse } from '../../src/server/config/runtime.js';

const port = Number(process.env.MOCK_PORT || 39010);

const config: Record<string, unknown> = {
  ...toConfigResponse(),
  // Keep the face awake and single-headed unless a test changes it.
  sleepTimeout: 600_000,
  dualHeadEnabled: false,
  dualHeadMode: 'off',
  ttsStreamingEnabled: true,
};

const defaultConfig = structuredClone(config);
const clients = new Set<WebSocket>();
let wsReceived: unknown[] = [];
let httpReceived: Array<{ method: string; path: string; body: unknown }> = [];

/** Mono 24 kHz 16-bit WAV of a quiet sine tone, base64, like a Kokoro chunk. */
export function toneWavBase64(durationMs: number): string {
  const rate = 24_000;
  const samples = Math.round((rate * durationMs) / 1000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), 44 + i * 2);
  }
  return buffer.toString('base64');
}

function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const type = String(request.headers['content-type'] ?? '');
      if (type.includes('json')) {
        try {
          resolve(JSON.parse(raw.toString() || 'null'));
          return;
        } catch {
          resolve(null);
          return;
        }
      }
      resolve({ bytes: raw.length, contentType: type });
    });
  });
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (path === '/__test/send' && method === 'POST') {
    const body = await readBody(request);
    for (const message of Array.isArray(body) ? body : [body]) broadcast(message);
    json(response, 200, { ok: true, clients: clients.size });
    return;
  }
  if (path === '/__test/received') {
    json(response, 200, { ws: wsReceived, http: httpReceived });
    return;
  }
  if (path === '/__test/reset' && method === 'POST') {
    wsReceived = [];
    httpReceived = [];
    // Config changes from one test must not leak into the next.
    if (JSON.stringify(config) !== JSON.stringify(defaultConfig)) {
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, structuredClone(defaultConfig));
      broadcast({ type: 'config', ...config });
    }
    json(response, 200, { ok: true });
    return;
  }
  if (path === '/__test/reset-received' && method === 'POST') {
    wsReceived = [];
    httpReceived = [];
    json(response, 200, { ok: true });
    return;
  }
  if (path === '/__test/clients') {
    json(response, 200, { clients: clients.size });
    return;
  }

  if (method === 'GET' && path === '/health') {
    json(response, 200, { status: 'ok', clients: clients.size, uptime: 1, service: 'tubs-face', mode: 'typescript' });
    return;
  }
  if (method === 'GET' && path === '/config') {
    json(response, 200, config);
    return;
  }
  if (method === 'GET' && path === '/stats') {
    json(response, 200, { messagesIn: 0, messagesOut: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, uptime: Date.now(), lastActivity: Date.now(), model: 'mock' });
    return;
  }
  if (method === 'GET' && path === '/faces') {
    json(response, 200, { faces: [] });
    return;
  }

  // Anything the page posts is recorded for assertions.
  const body = method === 'GET' ? null : await readBody(request);
  httpReceived.push({ method, path, body });
  if (method === 'POST' && path === '/config') {
    Object.assign(config, body as Record<string, unknown>);
    broadcast({ type: 'config', ...config });
    json(response, 200, config);
    return;
  }
  if (method === 'POST' && path === '/voice') {
    json(response, 200, { ok: true, ignored: true, reason: 'test' });
    return;
  }
  if (method === 'POST' && path === '/turn-script/manual') {
    const beats = (body as { beats?: unknown[] } | null)?.beats ?? [];
    json(response, 200, { ok: true, turnId: 'manual-turn', beatCount: beats.length });
    return;
  }
  if (method === 'POST') {
    json(response, 200, { ok: true });
    return;
  }
  json(response, 404, { error: `mock: no route for ${method} ${path}` });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'config', ...config }));
    ws.send(JSON.stringify({ type: 'system', text: 'Connected to mock server' }));
    ws.on('message', (raw) => {
      let message: { type?: string; text?: string; turnId?: string } | null = null;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!message || message.type === 'ping' || message.type === 'face_motion' || message.type === 'face_blink') return;
      wsReceived.push({ ...message, receivedAt: Date.now() });
      if (message.type === 'tts_request' && message.text) {
        // Answer like the TTS stream: one chunk per request, then speak_end.
        const { text, turnId } = message;
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'audio_chunk', audio: toneWavBase64(900), text, turnId, chunkIndex: 0 }));
          ws.send(JSON.stringify({ type: 'speak_end', turnId, text, fullText: text }));
        }, 60);
      }
    });
    ws.on('close', () => clients.delete(ws));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-server] listening on ${port}`);
});
