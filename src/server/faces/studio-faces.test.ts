import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { FaceObservation, StudioPart, StudioPulse, StudioResponse } from '../../shared/contracts/studio.js';
import { isFaceObservation } from '../../shared/guards/index.js';

// The whole server path with the face service on (docs/face-service.md): a
// fake service streams real ArcFace embeddings of public test faces; the server
// must name the enrolled one in the pulse, push observations to the listener
// page, answer onboarding itself, tell the listener page not to run its own
// worker, and keep answering GET /studio when the service dies.

const fixtures = JSON.parse(readFileSync(new URL('../../../tests/fixtures/faces/browser-embeddings.json', import.meta.url), 'utf8')) as {
  images: Record<string, { faces: Array<{ embedding: number[] }> }>;
};
const embeddingOf = (image: string, index = 0) => fixtures.images[image]!.faces[index]!.embedding;

// The fake face service, up before the server modules read FACE_SERVICE.
const streams = new Set<http.ServerResponse>();
const sources: unknown[] = [];
const READY = { state: 'ready', backend: 'CoreML', fps: 5, inferMs: 42, frames: 10, source: 'site:cam-facetest', camera: 'ok', where: 'box', threads: 4 };
const fake = http.createServer((request, response) => {
  if (request.url === '/source') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      sources.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }
  if (request.url === '/observations') {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    streams.add(response);
    response.on('close', () => streams.delete(response));
    return;
  }
  response.writeHead(404).end('{}');
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = (fake.address() as AddressInfo).port;
const libraryDir = mkdtempSync(path.join(os.tmpdir(), 'tubs-face-service-'));
writeFileSync(path.join(libraryDir, 'face-library.json'), JSON.stringify({ faces: [{ id: 'o1', name: 'Obama', embedding: embeddingOf('obama-2012.jpg') }] }));
process.env.FACE_SERVICE = `http://127.0.0.1:${fakePort}`;
process.env.TUBS_FACE_LIBRARY = path.join(libraryDir, 'face-library.json');
process.env.VISION_PROVIDER = 'off';

const { initWebSocketServer } = await import('../ws/server.js');
const { handleStudioRoute } = await import('../routes/studio-routes.js');
const { studioSettings } = await import('../studio/state.js');
const { startFaceService, stopFaceService, syncFaceService } = await import('./studio-faces.js');

let server: http.Server;
let port = 0;

function push(faces: Array<{ track: number; box: [number, number, number, number]; embedding: number[] }>): void {
  const line = { t: Date.now(), source: 'site:cam-facetest', frame: { w: 960, h: 540 }, faces: faces.map((face) => ({ ...face, score: 0.9 })), status: READY };
  for (const stream of streams) stream.write(`${JSON.stringify(line)}\n`);
}

async function connect(query: string): Promise<{ messages: Array<Record<string, unknown>>; send(message: unknown): void; socket: WebSocket }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { messages, socket, send: (message) => socket.send(JSON.stringify(message)) };
}

const get = async <T>(pathname: string): Promise<{ status: number; body: T }> => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: response.status, body: await response.json() as T };
};
const recognitionPart = async () => (await get<StudioResponse>('/studio')).body.parts!.find((part: StudioPart) => part.id === 'recognition')!;

beforeAll(async () => {
  Object.assign(studioSettings, { enabled: true, visionSource: 'site:cam-facetest', launch: 'external' });
  server = http.createServer((request, response) => {
    void handleStudioRoute(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'));
  });
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  startFaceService();
  syncFaceService();
  for (let waited = 0; streams.size === 0 && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  await stopFaceService();
  studioSettings.enabled = false;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (fake.listening) await new Promise<void>((resolve) => { fake.closeAllConnections(); fake.close(() => resolve()); });
  rmSync(libraryDir, { recursive: true, force: true });
});

describe('studio faces through the face service', () => {
  it('opens the site node stream over RTSP, and tells the listener page to start no worker of its own', async () => {
    expect(sources.at(-1)).toEqual({ url: 'rtsp://127.0.0.1:8554/cam-facetest', label: 'site:cam-facetest', fps: 5 });
    const listener = await connect('?studio=main');
    await expect.poll(() => listener.messages.find((m) => m.type === 'studio_config')).toMatchObject({ faces: 'service' });
    listener.socket.close();
  });

  it('names the enrolled face in the pulse, with how sure, and leaves the stranger unnamed', async () => {
    const listener = await connect('?studio=main');
    push([
      { track: 1, box: [96, 54, 288, 324], embedding: embeddingOf('obama-2009.jpg') },
      { track: 2, box: [600, 100, 700, 220], embedding: embeddingOf('apollo-11-crew.jpg', 1) },
    ]);
    await expect.poll(async () => (await get<StudioPulse>('/studio/pulse')).body.seen.length).toBe(2);
    const seen = (await get<StudioPulse>('/studio/pulse')).body.seen;
    expect(seen[0]).toMatchObject({ name: 'Obama', box: [0.1, 0.1, 0.2, 0.5] });
    expect(seen[0]!.prob).toBeGreaterThan(0.65);
    expect(seen[1]!.name).toBeNull();
    // The listener page gets the frame's faces (its sleep and proactive lines follow them).
    const observation = [...listener.messages].reverse().find((m) => m.type === 'face_observation')?.observation as FaceObservation;
    expect(isFaceObservation(observation)).toBe(true);
    expect(observation.faces.map((face) => face.decision)).toEqual(['match', 'unknown']);
    expect((await get<FaceObservation>('/studio/faces')).body.faces[0]).toMatchObject({ name: 'Obama', decision: 'match' });
    // Loopback shows as this machine's name, like every other part.
    expect(await recognitionPart()).toMatchObject({ where: `${os.hostname().replace(/\.local$/i, '')}:${fakePort}`, ok: true, detail: 'SCRFD+ArcFace · CoreML · 42 ms · 5 fps · 1 person' });
    listener.socket.close();
  });

  it('answers a dashboard\'s onboarding itself, with no listener page connected', async () => {
    const dashboard = await connect('?role=spectator');
    dashboard.send({ type: 'studio_face_call', id: 'b1', method: 'beginEnrollment' });
    await expect.poll(() => dashboard.messages.find((m) => m.type === 'studio_face_result')).toEqual({ type: 'studio_face_result', id: 'b1', ok: true, value: null });
    dashboard.send({ type: 'studio_face_call', id: 's1', method: 'saveEnrollment', args: { name: '', samples: [] } });
    await expect.poll(() => dashboard.messages.find((m) => m.id === 's1')).toMatchObject({ ok: false, error: 'Enter a name before saving' });
    dashboard.socket.close();
  });

  it('shows the service as not ok, with why, once it dies; GET /studio keeps answering', async () => {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await expect.poll(async () => (await recognitionPart()).ok, { timeout: 5000 }).toBe(false);
    expect((await recognitionPart()).detail).toMatch(/^face service not answering: /);
    const studio = await get<StudioResponse>('/studio');
    expect(studio.status).toBe(200);
    // Nobody is in view any more: the pulse does not keep showing the last faces.
    expect((await get<StudioPulse>('/studio/pulse')).body.seen).toEqual([]);
  });
});
