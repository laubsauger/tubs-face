import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { initWebSocketServer } from './server.js';
import { applyRuntimeConfigPatch, runtimeConfig } from '../config/runtime.js';
import { fieldNotesSnapshot } from '../assistant/field-notes.js';

// Pictures arrive on the same socket as everything else. Describing one can
// take seconds (or time out); the socket must keep serving meanwhile. And with
// vision off, no picture may leave the server, while knowing who is in front of
// Tubs (the face page's own detection) keeps working.

let server: http.Server;
let port = 0;
const requests: string[] = [];
let vision: http.Server;
let visionBase = '';
const snapshot = structuredClone(runtimeConfig);

beforeAll(async () => {
  server = http.createServer();
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // A vision server that takes 3 s to answer.
  vision = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'A slow look.' } }] }));
    }, 3000);
  });
  await new Promise<void>((resolve) => vision.listen(0, '127.0.0.1', resolve));
  visionBase = `http://127.0.0.1:${(vision.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  vision.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => vision.close(() => resolve())),
  ]);
});

afterEach(() => {
  Object.assign(runtimeConfig, snapshot);
  requests.length = 0;
});

async function connect(): Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));
  return { socket, messages };
}

const FRAME = `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;

describe('pictures on the socket', () => {
  it('never hold up the socket, however slow the vision server', async () => {
    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: visionBase, visionModel: 'm', visionTimeoutMs: 10_000 });
    const { socket, messages } = await connect();
    socket.send(JSON.stringify({ type: 'camera_frame', frame: FRAME }));
    const sentAt = Date.now();
    socket.send(JSON.stringify({ type: 'ping', ts: sentAt }));
    for (let i = 0; i < 40 && !messages.some((m) => m.type === 'ping' && m.ts === sentAt); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(messages.some((m) => m.type === 'ping' && m.ts === sentAt), 'pong while the picture is still being described').toBe(true);
    expect(Date.now() - sentAt).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toEqual(['/v1/chat/completions']);
    socket.close();
  });

  it('go nowhere with vision off, while who is in front of Tubs is still tracked', async () => {
    applyRuntimeConfigPatch({ visionProvider: 'off', visionBaseUrl: visionBase, visionModel: 'm' });
    const { socket } = await connect();
    socket.send(JSON.stringify({ type: 'appearance_frame', frame: FRAME, faces: ['Flo'], count: 1 }));
    socket.send(JSON.stringify({ type: 'camera_frame', frame: FRAME }));
    socket.send(JSON.stringify({ type: 'people', people: [{ id: 'v1', names: ['Flo'], position: 'center' }] }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toEqual([]);
    expect(fieldNotesSnapshot().people.map((person) => person.names)).toEqual([['Flo']]);
    socket.close();
  });
});
