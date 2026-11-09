import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadiness, type ReadinessSources } from './readiness.js';

// studio-manager restarts a service whose health check is not 200, and a
// show must not start on a tubs-face that cannot speak: "ready" means every
// part it needs right now is up, and only then.

const up = { status: 200, body: { status: 'ok', ready: true } };
function sources(patch: Partial<ReadinessSources> = {}): ReadinessSources {
  return {
    probe: async () => up,
    speechUrl: 'http://speech',
    mingUrl: 'http://ming',
    speechRunning: () => true,
    voices: () => ['ming:friend', 'ming:friend-b'],
    studio: () => ({ enabled: true, actors: [{ id: 'main', publishing: true }, { id: 'small', publishing: true }] }),
    ...patch,
  };
}

describe('readiness', () => {
  it('is ready with speech, Ming and both face pages up', async () => {
    const { ready, parts } = await createReadiness(sources()).check();
    expect(ready).toBe(true);
    expect(parts).toMatchObject({ speech: { state: 'up' }, ming: { state: 'up', needed: true }, studio: { state: 'up' } });
  });

  it('is not ready while the speech service is still loading, or gone', async () => {
    const loading = await createReadiness(sources({ probe: async (url) => (url.startsWith('http://speech') ? null : up) })).check();
    expect(loading).toMatchObject({ ready: false, parts: { speech: { state: 'starting' } } });
    const gone = await createReadiness(sources({ probe: async (url) => (url.startsWith('http://speech') ? null : up), speechRunning: () => false })).check();
    expect(gone.parts.speech.state).toBe('down');
  });

  it('needs Ming only for ming: voices, and waits for its model to load', async () => {
    const kokoro = await createReadiness(sources({ voices: () => ['af_heart'], probe: async (url) => (url.startsWith('http://ming') ? null : up) })).check();
    expect(kokoro).toMatchObject({ ready: true, parts: { ming: { state: 'off', needed: false } } });
    const loading = await createReadiness(sources({ probe: async (url) => (url.startsWith('http://ming') ? { status: 200, body: { status: 'ok', ready: false } } : up) })).check();
    expect(loading).toMatchObject({ ready: false, parts: { ming: { state: 'starting' } } });
  });

  it('counts the face pages only in studio mode, and names the one not publishing', async () => {
    const off = await createReadiness(sources({ studio: () => ({ enabled: false, actors: [{ id: 'main', publishing: false }] }) })).check();
    expect(off).toMatchObject({ ready: true, parts: { studio: { state: 'off' } } });
    const down = await createReadiness(sources({ studio: () => ({ enabled: true, actors: [{ id: 'main', publishing: true }, { id: 'small', publishing: false, error: 'face page not connected' }] }) })).check();
    expect(down.ready).toBe(false);
    expect(down.parts.studio.actors).toContainEqual({ id: 'small', publishing: false, error: 'face page not connected' });
  });
});

describe('GET /healthz', () => {
  let speech: http.Server;
  let ming: http.Server;
  let api: http.Server;
  let base = '';
  let speechUp = false;

  beforeAll(async () => {
    const listen = async (server: http.Server) => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    };
    speech = http.createServer((_request, response) => {
      response.writeHead(speechUp ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: speechUp ? 'ok' : 'loading' }));
    });
    ming = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', ready: true }));
    });
    process.env.REALTIME_PROCESSING_PORT = String(await listen(speech));
    process.env.MING_PORT = String(await listen(ming));
    process.env.MING_TTS_URL = `http://127.0.0.1:${process.env.MING_PORT}`;
    const { handleApiRequest } = await import('../routes/api.js');
    api = http.createServer((request, response) => void handleApiRequest(request, response));
    base = `http://127.0.0.1:${await listen(api)}`;
  });

  afterAll(async () => {
    await Promise.all([speech, ming, api].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('answers 503 until the parts are up, then 200; /health shows the parts either way', async () => {
    const notYet = await fetch(`${base}/healthz`);
    expect(notYet.status).toBe(503);
    expect(((await notYet.json()) as { parts: { speech: { state: string } } }).parts.speech.state).not.toBe('up');
    expect((await fetch(`${base}/health`)).status).toBe(200);
    speechUp = true;
    await new Promise((resolve) => setTimeout(resolve, 1100)); // past the probe cache
    const ready = await fetch(`${base}/healthz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, parts: { speech: { state: 'up' } } });
  });
});
