import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { StudioSourcesResponse } from '../../shared/contracts/studio.js';
import { handleStudioRoute } from '../routes/studio-routes.js';
import { initWebSocketServer } from '../ws/server.js';
import { listStudioSources } from './sources.js';
import { resetStudioReports, studioSettings, studioSettingsFromEnv, type StudioSettings } from './state.js';

// The Studio tab (and the sentient panel) offer what the mic and vision can be
// set to instead of asking for remembered strings. A wrong entry there is worse
// than none: our own faces as a mic would make Tubs hear himself, a video-only
// stream as a mic hears nothing, and a hub that is down must never break the list.

interface Stub {
  url: string;
  requests: Array<{ path: string; authorization?: string }>;
  close(): Promise<void>;
}

async function stub(answer: (path: string, request: http.IncomingMessage) => { status: number; body: unknown }): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    requests.push({ path: url, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    const { status, body } = answer(url, request);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// What mediamtx's /v3/paths/list gives (v1.x, trimmed).
const PATHS = {
  itemCount: 6,
  pageCount: 1,
  items: [
    { name: 'cam-flo-mac', ready: true, tracks: ['H264', 'Opus'], tracks2: [{ codec: 'H264' }, { codec: 'Opus' }] },
    { name: 'mic-booth', ready: true, tracks: ['Opus'] },
    { name: 'cam-c920', ready: true, tracks: ['H264'] },
    { name: 'tubs-main', ready: true, tracks: ['H264', 'Opus'] },
    { name: 'os-couch', ready: true, tracks: ['H264'] },
    { name: 'mic-old', ready: false, tracks: [] },
  ],
};

const settingsFor = (site: string, patch: Partial<StudioSettings> = {}): StudioSettings => ({ ...studioSettingsFromEnv({ TUBS_STUDIO_SITE: site }), ...patch });
const values = (list: Array<{ value: string }>) => list.map((source) => source.value);

let site: Stub;

beforeAll(async () => {
  site = await stub((url) => (url.startsWith('/v3/paths/list') ? { status: 200, body: PATHS } : { status: 404, body: {} }));
});

afterAll(async () => {
  await site.close();
});

afterEach(() => {
  resetStudioReports();
  delete process.env.TUBS_STUDIO_SITE_API_AUTH;
  delete process.env.TUBS_STUDIO_SITE_READ_AUTH;
});

describe('site streams', () => {
  it('offer paths with audio for the mic and paths with video for vision, never our own faces or window streams', async () => {
    const sources = await listStudioSources({ settings: settingsFor('http://127.0.0.1:8889', { micSource: 'off' }), env: { TUBS_STUDIO_SITE_API: site.url } });
    const micSite = sources.mic.filter((source) => source.kind === 'site');
    expect(micSite).toEqual([
      { value: 'site:cam-flo-mac', label: 'cam-flo-mac', kind: 'site', ready: true, tracks: ['H264', 'Opus'] },
      { value: 'site:mic-booth', label: 'mic-booth', kind: 'site', ready: true, tracks: ['Opus'] },
    ]);
    // Video only: nothing to hear.
    expect(values(sources.mic)).not.toContain('site:cam-c920');
    expect(values(sources.vision.filter((source) => source.kind === 'site'))).toEqual(['site:cam-c920', 'site:cam-flo-mac']);
    for (const list of [sources.mic, sources.vision]) {
      expect(values(list).filter((value) => value.includes('tubs-') || value.includes('os-'))).toEqual([]);
      expect(list[0]).toEqual({ value: 'off', label: 'Off', kind: 'off', ready: true });
    }
    expect(sources.problems).toEqual([]);
  });

  it('read the site node API on the site host at :9997 unless TUBS_STUDIO_SITE_API says otherwise', async () => {
    const asked: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    await listStudioSources({ settings: settingsFor('https://site.example:8889'), env: {}, fetch: fetchStub });
    expect(asked).toEqual(['http://site.example:9997/v3/paths/list?itemsPerPage=1000']);
  });

  it('send the api login when the site needs one, and say what is wrong without the password', async () => {
    const SECRET = 'api-pa55-never-shown';
    const header = `Basic ${Buffer.from(`api:${SECRET}`).toString('base64')}`;
    const locked = await stub((url, request) => (request.headers.authorization === header && url.startsWith('/v3/paths/list') ? { status: 200, body: PATHS } : { status: 401, body: { error: 'authentication error' } }));
    try {
      const settings = settingsFor('http://127.0.0.1:8889');
      const refused = await listStudioSources({ settings, env: { TUBS_STUDIO_SITE_API: locked.url } });
      expect(refused.problems).toEqual([expect.stringContaining('refused the login (401)')]);
      expect(values(refused.mic)).toEqual(['off', 'local']);

      const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-sources-'));
      const file = path.join(dir, 'api-login.json');
      writeFileSync(file, JSON.stringify({ user: 'api', pass: SECRET }));
      // The read login serves for the API when there is no separate file.
      process.env.TUBS_STUDIO_SITE_READ_AUTH = file;
      const allowed = await listStudioSources({ settings, env: { TUBS_STUDIO_SITE_API: locked.url } });
      expect(values(allowed.mic)).toContain('site:cam-flo-mac');
      expect(locked.requests.at(-1)?.authorization).toBe(header);

      process.env.TUBS_STUDIO_SITE_API_AUTH = path.join(dir, 'missing.json');
      const missing = await listStudioSources({ settings, env: { TUBS_STUDIO_SITE_API: locked.url } });
      expect(missing.problems[0]).toContain('TUBS_STUDIO_SITE_API_AUTH');
      for (const response of [refused, allowed, missing]) expect(JSON.stringify(response)).not.toContain(SECRET);
    } finally {
      await locked.close();
    }
  });

  it('say so when the site node API does not answer, and still offer this Mac', async () => {
    const gone = await stub(() => ({ status: 200, body: {} }));
    await gone.close();
    const sources = await listStudioSources({ settings: settingsFor('http://127.0.0.1:8889'), env: { TUBS_STUDIO_SITE_API: gone.url } });
    expect(sources.problems).toEqual([expect.stringContaining('not answering')]);
    expect(values(sources.mic)).toEqual(['off', 'local']);
  });
});

describe('suggestion', () => {
  const onlyOne = { items: [{ name: 'cam-flo-mac', ready: true, tracks: ['H264', 'Opus'] }, { name: 'tubs-main', ready: true, tracks: ['H264', 'Opus'] }] };

  it('names the one live remote source while the current one is off or gone', async () => {
    const one = await stub(() => ({ status: 200, body: onlyOne }));
    try {
      const env = { TUBS_STUDIO_SITE_API: one.url };
      const off = await listStudioSources({ settings: settingsFor('http://127.0.0.1:8889', { micSource: 'off', visionSource: 'off' }), env });
      expect(off.suggested).toEqual({
        mic: expect.objectContaining({ value: 'site:cam-flo-mac', label: 'cam-flo-mac' }),
        vision: expect.objectContaining({ value: 'site:cam-flo-mac' }),
      });
      const gone = await listStudioSources({ settings: settingsFor('http://127.0.0.1:8889', { micSource: 'site:mic-unplugged' }), env });
      expect(gone.suggested.mic?.value).toBe('site:cam-flo-mac');
      // Already on it: nothing to suggest.
      const using = await listStudioSources({ settings: settingsFor('http://127.0.0.1:8889', { micSource: 'site:cam-flo-mac', visionSource: 'site:cam-flo-mac' }), env });
      expect(using.suggested).toEqual({});
    } finally {
      await one.close();
    }
  });

  it('is left out when there is more than one candidate: that choice is the operator\'s', async () => {
    const sources = await listStudioSources({ settings: settingsFor('http://127.0.0.1:8889', { micSource: 'off' }), env: { TUBS_STUDIO_SITE_API: site.url } });
    expect(sources.suggested.mic).toBeUndefined();
  });
});

describe('depth camera snapshots', () => {
  const plan = {
    placeables: [
      { id: 'depthcam:204-eeg/depthcam-realsense', kind: 'depthcam', label: 'RealSense · 204-eeg', node: '204-eeg', service: 'depthcam-realsense', at: [3, 4] },
      { id: 'depthcam:msi/depthcam-femto', kind: 'depthcam', label: 'Femto · msi', node: 'msi', service: 'depthcam-femto' }, // not placed
      { id: 'camera:cam-c920', kind: 'camera', label: 'C920', node: 'msi', at: [1, 1] },
    ],
  };
  const fleet = {
    nodes: [
      { name: '204-eeg', online: true, services: [{ name: 'depthcam-realsense', base: 'http://204-eeg.tail:8090', healthy: true }] },
      { name: 'msi', online: true, services: [{ name: 'depthcam-femto', base: 'http://msi.tail:8091', healthy: true }] },
    ],
  };

  it('come from the floor plan\'s placed depth cameras, at their service\'s snapshot URL', async () => {
    const hub = await stub((url) => (url === '/api/floorplan' ? { status: 200, body: plan } : url === '/api/fleet' ? { status: 200, body: fleet } : { status: 404, body: {} }));
    try {
      const sources = await listStudioSources({ settings: settingsFor('http://127.0.0.1:8889'), env: { TUBS_STUDIO_SITE_API: site.url, FLEET_HUB: `${hub.url}/` } });
      expect(sources.vision.filter((source) => source.kind === 'snapshot')).toEqual([
        { value: 'snapshot:http://204-eeg.tail:8090/api/snapshot/color.jpg', label: 'RealSense · 204-eeg', kind: 'snapshot', ready: true },
      ]);
      expect(values(sources.mic).some((value) => value.startsWith('snapshot:'))).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it('are left out, with no error, when FLEET_HUB is unset or the hub does not answer', async () => {
    const settings = settingsFor('http://127.0.0.1:8889');
    const unset = await listStudioSources({ settings, env: { TUBS_STUDIO_SITE_API: site.url } });
    const gone = await stub(() => ({ status: 200, body: {} }));
    await gone.close();
    const down = await listStudioSources({ settings, env: { TUBS_STUDIO_SITE_API: site.url, FLEET_HUB: gone.url } });
    for (const sources of [unset, down]) {
      expect(sources.vision.filter((source) => source.kind === 'snapshot')).toEqual([]);
      expect(sources.problems).toEqual([]);
      expect(values(sources.vision)).toContain('site:cam-c920');
    }
  });
});

describe('this Mac\'s devices, from the listener page', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      void handleStudioRoute(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'));
    });
    initWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('are listed as local:<label> while the page is connected, and not ready once it is gone', async () => {
    const before = process.env.TUBS_STUDIO_SITE_API;
    process.env.TUBS_STUDIO_SITE_API = site.url;
    studioSettings.enabled = true;
    const page = new WebSocket(`ws://127.0.0.1:${port}/ws?studio=main`);
    try {
      await new Promise<void>((resolve, reject) => {
        page.once('open', () => resolve());
        page.once('error', reject);
      });
      page.send(JSON.stringify({
        type: 'studio_status',
        actor: 'main',
        publishing: true,
        devices: { audio: ['MacBook Pro Microphone', 'Scarlett 2i2 USB'], video: ['FaceTime HD Camera'] },
      }));
      const read = async () => (await (await fetch(`http://127.0.0.1:${port}/studio/sources`)).json()) as StudioSourcesResponse;
      await expect.poll(async () => (await read()).mic.filter((source) => source.kind === 'local')).toEqual([
        { value: 'local', label: 'Default input', kind: 'local', ready: true },
        { value: 'local:MacBook Pro Microphone', label: 'MacBook Pro Microphone', kind: 'local', ready: true },
        { value: 'local:Scarlett 2i2 USB', label: 'Scarlett 2i2 USB', kind: 'local', ready: true },
      ]);
      expect((await read()).vision.filter((source) => source.kind === 'local').map((source) => source.value)).toEqual(['local', 'local:FaceTime HD Camera']);
      page.close();
      await expect.poll(async () => (await read()).mic.filter((source) => source.kind === 'local').every((source) => !source.ready)).toBe(true);
    } finally {
      page.close();
      studioSettings.enabled = false;
      if (before === undefined) delete process.env.TUBS_STUDIO_SITE_API;
      else process.env.TUBS_STUDIO_SITE_API = before;
    }
  });
});
