import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROPS } from '../../shared/contracts/config.js';

// What each head wears is set live mid-show, through POST /config like the
// rest of the look: the face pages (and so the published streams) pick it up
// from the config broadcast, without a restart. The director and the panel
// send ids; one that doesn't exist is refused with the ids that do.

process.env.TUBS_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'tubs-props-'));
process.env.TUBS_STATE_FILE = '';

const { handleApiRequest } = await import('./api.js');
const { initWebSocketServer } = await import('../ws/server.js');
const { runtimeConfig } = await import('../config/runtime.js');

let server: http.Server;
let base = '';
const original = structuredClone(runtimeConfig);

beforeAll(async () => {
  server = http.createServer((request, response) => void handleApiRequest(request, response));
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  Object.assign(runtimeConfig, original);
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (body: unknown) => fetch(`${base}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('props through POST /config', () => {
  it('puts a hat on each head live and tells the open pages', async () => {
    const page = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const configs: Array<Record<string, unknown>> = [];
    page.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === 'config') configs.push(message);
    });
    await new Promise<void>((resolve) => page.once('open', () => resolve()));

    const response = await post({ propMain: 'party-hat', propSmall: 'crown' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ propMain: 'party-hat', propSmall: 'crown' });
    await expect.poll(() => configs.at(-1)).toMatchObject({ propMain: 'party-hat', propSmall: 'crown' });
    page.close();
  });

  it('refuses an unknown id with a 400 naming the valid ones, and leaves the hats as they were', async () => {
    const before = { propMain: runtimeConfig.propMain, propSmall: runtimeConfig.propSmall };
    const response = await post({ propMain: 'sombrero' });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain('propMain');
    for (const id of PROPS) expect(error).toContain(id);
    expect({ propMain: runtimeConfig.propMain, propSmall: runtimeConfig.propSmall }).toEqual(before);
  });
});
