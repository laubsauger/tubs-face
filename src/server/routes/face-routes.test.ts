import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

// In studio mode the face pages run on the studio Mac and the person fixing a
// wrong match sits at a dashboard, maybe on another machine. A change to the
// face library (an onboarding, a rename, a removal) has to reach the pages
// that match faces against their own copy, or the wrong name stays on screen;
// and an onboarding of five shots reloads them once, not five times.

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-face-routes-'));
const libraryFile = path.join(dir, 'face-library.json');
writeFileSync(libraryFile, JSON.stringify({ faces: [] }));
process.env.TUBS_FACE_LIBRARY = libraryFile;

const { handleApiRequest } = await import('./api.js');
const { initWebSocketServer } = await import('../ws/server.js');

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    void handleApiRequest(request, response);
  });
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('face library changes', () => {
  it('tell every page to reload its copy, once per burst of changes', async () => {
    const page = new WebSocket(`${base.replace('http', 'ws')}/ws?studio=main`);
    const changes: unknown[] = [];
    page.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string };
      if (message.type === 'faces_changed') changes.push(message);
    });
    await new Promise<void>((resolve) => page.once('open', () => resolve()));
    try {
      const post = (embedding: number[]) => fetch(`${base}/faces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Flo', embedding }) });
      const created = (await (await post([0.1, 0.2])).json()) as { face: { id: string } };
      await post([0.2, 0.3]);
      await post([0.3, 0.4]);
      await expect.poll(() => changes.length, { timeout: 2000 }).toBe(1);

      await fetch(`${base}/faces`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: created.face.id, name: 'Dimi' }) });
      await expect.poll(() => changes.length, { timeout: 2000 }).toBe(2);
      await fetch(`${base}/faces?id=${encodeURIComponent(created.face.id)}`, { method: 'DELETE' });
      await expect.poll(() => changes.length, { timeout: 2000 }).toBe(3);
      // Nothing removed, nothing to reload.
      await fetch(`${base}/faces?id=nobody`, { method: 'DELETE' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(changes).toHaveLength(3);
    } finally {
      page.close();
    }
  });
});

// "Add photos to Flo" and picking Flo in the onboarding picker add samples to
// Flo. However the name arrives ("flo", " Flo "), they must land under Flo,
// never as a second Flo beside the first.
describe('adding samples to someone already in the library', () => {
  it('never makes a second person with the same name', async () => {
    const post = (name: string, embedding: number[]) => fetch(`${base}/faces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, embedding }) });
    await post('Rosa', [0.1]);
    const lower = (await (await post('rosa', [0.2])).json()) as { face: { name: string } };
    const spaced = (await (await post('  ROSA ', [0.3])).json()) as { face: { name: string } };
    expect([lower.face.name, spaced.face.name]).toEqual(['Rosa', 'Rosa']);
    const library = (await (await fetch(`${base}/faces`)).json()) as { faces: Array<{ id: string; name: string }> };
    expect(new Set(library.faces.filter((face) => face.name.toLowerCase().trim() === 'rosa').map((face) => face.name))).toEqual(new Set(['Rosa']));
    // Renaming a sample to someone who is there joins them too.
    const other = (await (await post('Unknown visitor', [0.4])).json()) as { face: { id: string } };
    const renamed = (await (await fetch(`${base}/faces`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: other.face.id, name: 'rosa' }) })).json()) as { face: { name: string } };
    expect(renamed.face.name).toBe('Rosa');
  });
});
