import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { MemoryCard, MemoryResponse } from '../../shared/contracts/memory.js';

// The memory view is the operator's overview of what Tubs knows about whom
// tonight, and the place to take it back: forgetting must reach the prompt,
// a removal from the face library must take the photos with it and stop the
// face pages recognising that person, and nothing may change without a
// deliberate POST from the dashboard itself.

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-memory-'));
const libraryFile = path.join(dir, 'face-library.json');
process.env.TUBS_FACE_LIBRARY = libraryFile;
process.env.TUBS_CONFIG_DIR = dir;
const ATTITUDE = 'He is the boss. Be warm and nice to him (playful respect, never grovelling); still yourself.';
writeFileSync(path.join(dir, 'relationships.json'), JSON.stringify([{ name: 'Flo', attitude: ATTITUDE }]));

const jpeg = (label: string) => `data:image/jpeg;base64,${Buffer.from(`jpeg of ${label}`).toString('base64')}`;
const LIBRARY = {
  faces: [
    { id: 'flo1', name: 'Flo', embedding: [0.1], createdAt: 1, thumbnail: jpeg('flo 1') },
    { id: 'flo2', name: 'Flo', embedding: [0.2], createdAt: 2, thumbnail: jpeg('flo 2') },
    { id: 'dimi1', name: 'Dimi', embedding: [0.3], createdAt: 3, thumbnail: jpeg('dimi') },
  ],
};

const { handleApiRequest } = await import('./api.js');
const { initWebSocketServer } = await import('../ws/server.js');
const notes = await import('../assistant/field-notes.js');
const { isLocalNetworkAddress } = await import('../memory/view.js');

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    void handleApiRequest(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  writeFileSync(libraryFile, JSON.stringify(LIBRARY));
  notes.resetFieldNotes();
});

const memory = async () => (await (await fetch(`${base}/memory`)).json()) as MemoryResponse;
const card = (m: MemoryResponse, key: string) => m.cards.find((each) => each.key === key) as MemoryCard;
const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the memory view', () => {
  it('shows someone who has left, with their notes, quotes and the snapshot from when they were noted', async () => {
    notes.setPeople([{ id: 'v7', names: [], position: 'center', snapshots: 1, thumbnail: jpeg('stranger') }]);
    notes.recordFieldNotes('Nice. [[NOTE: works night shifts at the bakery]] [[QUOTE: bread is a lifestyle]]');
    notes.setPeople([]);

    const visitor = card(await memory(), 'visitor:v7');
    expect(visitor).toMatchObject({ name: null, seenTonight: true, inView: null, enrolled: false, notes: ['works night shifts at the bakery'], quotes: ['bread is a lifestyle'] });
    expect(visitor.photos).toHaveLength(1);
    const photo = await fetch(`${base}${visitor.photos[0]!.url}`);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await photo.arrayBuffer()).toString()).toBe('jpeg of stranger');
  });

  it('puts a known person on one card: tonight\'s notes, library photos, relationship and where they are', async () => {
    notes.setPeople([{ id: 'v1', names: ['Flo'], position: 'left' }, { id: 'v2', names: [], position: 'right' }]);
    notes.recordFieldNotes('[[NOTE left: building a robot]]');

    const m = await memory();
    const flo = card(m, 'name:flo');
    expect(flo).toMatchObject({ name: 'Flo', enrolled: true, inView: 'left', notes: ['building a robot'], attitude: ATTITUDE });
    expect(flo.library.map((entry) => entry.id)).toEqual(['flo1', 'flo2']);
    expect(flo.photos.map((photo) => photo.source)).toEqual(['library', 'library']);
    expect(Buffer.from(await (await fetch(`${base}${flo.photos[1]!.url}`)).arrayBuffer()).toString()).toBe('jpeg of flo 2');
    // Known to the library but not seen tonight: still a card, after the people of tonight.
    expect(card(m, 'name:dimi')).toMatchObject({ seenTonight: false, enrolled: true, attitude: null });
    expect(m.cards.map((each) => each.key).indexOf('name:dimi')).toBeGreaterThan(m.cards.map((each) => each.key).indexOf('visitor:v2'));
    expect(m.counts).toEqual({ tonight: 2, inView: 2, enrolled: 2 });
  });

  it('lists the face library as /faces has it', async () => {
    const faces = (await (await fetch(`${base}/faces`)).json()) as { faces: Array<{ name: string }> };
    const counts = new Map<string, number>();
    for (const face of faces.faces) counts.set(face.name, (counts.get(face.name) ?? 0) + 1);
    expect((await memory()).library).toEqual([...counts].map(([name, samples]) => ({ name, samples })));
  });
});

describe('admin actions in the memory view', () => {
  it('forget a person tonight: their notes and quotes are gone from the next prompt too', async () => {
    notes.setPeople([{ id: 'v1', names: ['Flo'], position: 'center' }]);
    notes.recordFieldNotes('[[NOTE: loves techno]] [[QUOTE: one more track]]');
    expect(notes.memoryContext()).toContain('loves techno');

    expect((await post('/memory/forget', { key: 'visitor:nobody' })).status).toBe(404);
    expect(notes.memoryContext()).toContain('loves techno');

    expect((await post('/memory/forget', { key: 'name:flo' })).status).toBe(200);
    expect(notes.memoryContext()).not.toContain('loves techno');
    notes.setPeople([]);
    expect(notes.pickGossip()).toBeNull();
    // Still in the face library: the card stays, without tonight's notes.
    expect(card(await memory(), 'name:flo')).toMatchObject({ notes: [], quotes: [], enrolled: true });
  });

  it('remove someone from the face library, photos included, and tell the face pages', async () => {
    const page = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const received: string[] = [];
    page.on('message', (raw) => received.push((JSON.parse(String(raw)) as { type: string }).type));
    await new Promise<void>((resolve) => page.once('open', () => resolve()));

    const before = card(await memory(), 'name:dimi');
    expect((await post('/memory/library/remove', { name: 'Dimi' })).status).toBe(200);
    const faces = (await (await fetch(`${base}/faces`)).json()) as { faces: Array<{ name: string }> };
    expect(faces.faces.map((face) => face.name)).toEqual(['Flo', 'Flo']);
    expect((await fetch(`${base}${before.photos[0]!.url}`)).status).toBe(404);
    expect(card(await memory(), 'name:dimi')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toContain('faces_changed');
    page.close();
  });

  it('clear tonight\'s notes, and only those', async () => {
    notes.setPeople([{ id: 'v1', names: ['Flo'], position: 'center' }]);
    notes.recordFieldNotes('[[NOTE: loves techno]]');
    expect((await post('/memory/clear', {})).status).toBe(200);
    expect(notes.memoryContext()).toBe('');
    expect((await memory()).library).toHaveLength(2);
  });

  it('change nothing without a deliberate POST from the dashboard itself', async () => {
    notes.setPeople([{ id: 'v1', names: ['Flo'], position: 'center' }]);
    notes.recordFieldNotes('[[NOTE: loves techno]]');
    const library = (await (await fetch(`${base}/faces`)).text());

    expect((await fetch(`${base}/memory/clear`)).status).toBe(404);
    expect((await fetch(`${base}/memory/forget?key=name:flo`)).status).toBe(404);
    expect((await fetch(`${base}/memory/library/remove?name=Flo`)).status).toBe(404);
    // Another site open in the operator's browser.
    expect((await post('/memory/clear', {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('/memory/library/remove', { name: 'Flo' }, { origin: 'http://elsewhere.example' })).status).toBe(403);
    // A plain form post (no preflight) is not JSON.
    expect((await fetch(`${base}/memory/clear`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    // The preflight a cross-origin JSON post needs is never granted.
    const preflight = await fetch(`${base}/memory/clear`, { method: 'OPTIONS', headers: { origin: 'http://elsewhere.example', 'access-control-request-method': 'POST' } });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

    expect(notes.memoryContext()).toContain('loves techno');
    expect(await (await fetch(`${base}/faces`)).text()).toBe(library);
  });

  it('answer the local network only', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '172.16.4.2', '172.31.255.1', '192.168.1.20', '::ffff:192.168.0.7', '169.254.3.3', 'fd12:3456::1', 'fe80::1']) {
      expect(isLocalNetworkAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:db8::1', '::ffff:1.2.3.4', undefined]) {
      expect(isLocalNetworkAddress(address), String(address)).toBe(false);
    }
  });
});

describe('the studio links', () => {
  it('include the memory view and the dashboard, as the caller reaches this server', async () => {
    const studio = (await (await fetch(`${base}/studio`)).json()) as { ui: { dashboard: string; memory: string } };
    expect(studio.ui).toEqual({ dashboard: `${base}/?view=dashboard`, memory: `${base}/?view=memory` });
  });
});
