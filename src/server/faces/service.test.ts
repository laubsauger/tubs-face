import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFaceServiceClient, parseFaceServiceMode, type ServiceLine } from './service.js';

// The face service is another process, possibly on another box: it may be
// down, restarting or slow. The server must keep answering (GET /studio parts
// says what is wrong), tell a restarted service its camera again, and never
// throw because of it.

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

const STATUS = { state: 'ready', backend: 'CPU', fps: 5, inferMs: 30, frames: 1, source: 'site:cam-1', camera: 'ok', where: 'box' };

async function fakeService(): Promise<{ base: string; sources: unknown[]; push: (line: unknown) => void; server: http.Server }> {
  const sources: unknown[] = [];
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((request, response) => {
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
      response.write(`${JSON.stringify({ t: 1, source: null, frame: null, faces: [], status: STATUS })}\n`);
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, sources, server, push: (line) => { for (const stream of streams) stream.write(`${JSON.stringify(line)}\n`); } };
}

describe('FACE_SERVICE', () => {
  it('reads off, local, a URL and fleet:faces, and nothing else', () => {
    expect(parseFaceServiceMode(undefined)).toEqual({ kind: 'off' });
    expect(parseFaceServiceMode('off')).toEqual({ kind: 'off' });
    expect(parseFaceServiceMode('local', 3999)).toEqual({ kind: 'local', port: 3999 });
    expect(parseFaceServiceMode('http://10.0.0.5:3004/')).toEqual({ kind: 'url', base: 'http://10.0.0.5:3004' });
    expect(parseFaceServiceMode('fleet:faces')).toEqual({ kind: 'fleet' });
    expect(parseFaceServiceMode('fleet:vision')).toBeNull();
    expect(parseFaceServiceMode('ftp://box')).toBeNull();
  });
});

describe('the face service client', () => {
  it('tells the service its camera, streams its frames, and tells a reconnected service the camera again', async () => {
    const service = await fakeService();
    const lines: ServiceLine[] = [];
    const client = createFaceServiceClient({ mode: { kind: 'url', base: service.base }, onLine: (line) => lines.push(line), controller: null, hostname: 'here', log: () => undefined });
    client.setSource({ url: 'rtsp://site:8554/cam-1', label: 'site:cam-1', fps: 5 });
    client.start();
    await expect.poll(() => lines.length).toBeGreaterThan(0);
    expect(service.sources).toEqual([{ url: 'rtsp://site:8554/cam-1', label: 'site:cam-1', fps: 5 }]);
    service.push({ t: 2, source: 'site:cam-1', frame: { w: 960, h: 540 }, faces: [{ track: 1, box: [1, 2, 3, 4], score: 0.9, embedding: [0.1] }], status: STATUS });
    await expect.poll(() => lines.at(-1)?.faces.length).toBe(1);
    expect(client.status()).toMatchObject({ mode: 'url', health: { state: 'ready' }, error: null });
    // The stream drops (a service restart): the camera is sent again on the next connection.
    service.server.closeAllConnections();
    await expect.poll(() => service.sources.length, { timeout: 6000 }).toBe(2);
    await client.stop();
  }, 15_000);

  it('a service that is down is a status with a reason, never an exception', async () => {
    const closed = await fakeService();
    const base = closed.base;
    await new Promise((resolve) => { closed.server.close(resolve); servers.splice(servers.indexOf(closed.server), 1); });
    const downs: Array<string | null> = [];
    const client = createFaceServiceClient({ mode: { kind: 'url', base }, onLine: () => undefined, onDown: (reason) => downs.push(reason), controller: null, hostname: 'here', log: () => undefined });
    client.start();
    await expect.poll(() => downs.length).toBeGreaterThan(0);
    const status = client.status();
    expect(status.health).toBeNull();
    expect(status.error).toMatch(/refused|not running/);
    expect(status.where).toBe(new URL(base).host.replace('127.0.0.1', 'here'));
    await expect(client.capture()).rejects.toThrow();
    await expect(client.frame(512)).rejects.toThrow();
    await client.stop();
  });
});
