import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { StudioResponse } from '../../shared/contracts/studio.js';

// Each part of what Tubs perceives switches on its own, live, and stays
// switched across a restart: the camera, face recognition (the listener's
// face worker), the vision descriptions (the provider), the relationships and
// the mic. One must never drag another along: descriptions off still
// recognises faces; recognition off still describes pictures.

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-switches-'));
process.env.TUBS_STATE_FILE = path.join(dir, 'state.json');

const { handleStudioRoute } = await import('../routes/studio-routes.js');
const { initWebSocketServer } = await import('../ws/server.js');
const { runtimeConfig } = await import('../config/runtime.js');
const { studioSettings, studioSettingsFromEnv } = await import('./state.js');
const { restoreState } = await import('../state-file.js');

let server: http.Server;
let base = '';
const configBefore = { ...runtimeConfig };
const settingsBefore = { ...studioSettings };

beforeAll(async () => {
  server = http.createServer((request, response) => {
    void handleStudioRoute(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'));
  });
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  Object.assign(runtimeConfig, configBefore);
  Object.assign(studioSettings, settingsBefore);
});

const post = async (body: unknown) => fetch(`${base}/studio`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('the studio switches', () => {
  it('switch each part on its own, live, and the listener page hears the ones it acts on', async () => {
    studioSettings.enabled = true;
    const page = new WebSocket(`${base.replace('http', 'ws')}/ws?studio=main`);
    const configs: Array<Record<string, unknown>> = [];
    page.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === 'studio_config') configs.push(message);
    });
    await new Promise<void>((resolve) => page.once('open', () => resolve()));
    try {
      const off = (await (await post({ switches: { visionDescriptions: false } })).json()) as StudioResponse;
      // Descriptions off: recognition, the camera and the rest stay on.
      expect(off.switches).toEqual({ camera: true, faceRecognition: true, visionDescriptions: false, relationships: true, mic: true });
      expect(runtimeConfig.visionDescriptions).toBe(false);
      expect(off.parts?.find((part) => part.id === 'vision')).toMatchObject({ where: 'off', ok: null, detail: expect.stringContaining('switched off') });

      const recognition = (await (await post({ switches: { faceRecognition: false, visionDescriptions: true } })).json()) as StudioResponse;
      expect(recognition.switches).toMatchObject({ faceRecognition: false, visionDescriptions: true, camera: true });
      await expect.poll(() => configs.at(-1)?.switches).toEqual({ camera: true, faceRecognition: false, mic: true });
      // Recognition off names nobody; faces are still found while descriptions need them.
      expect(recognition.parts?.find((part) => part.id === 'recognition')).toMatchObject({ where: 'off', ok: null, detail: 'switched off (faces are still detected, for descriptions)' });

      await post({ switches: { mic: false, camera: false, relationships: false } });
      await expect.poll(() => configs.at(-1)?.switches).toEqual({ camera: false, faceRecognition: false, mic: false });
      expect(runtimeConfig.relationshipsEnabled).toBe(false);
      // The source choices stay: switching back on needs no remembering.
      expect(studioSettings.micSource).toBe(settingsBefore.micSource);
    } finally {
      page.close();
    }
  });

  it('refuse an unknown switch or a non-boolean, changing nothing', async () => {
    const response = await post({ switches: { mic: false, laser: true } });
    expect(response.status).toBe(400);
    expect(studioSettings.micOn).toBe(true);
    expect((await post({ switches: { mic: 'no' } })).status).toBe(400);
    expect(studioSettings.micOn).toBe(true);
  });

  it('come back after a restart (TUBS_STATE_FILE)', async () => {
    await post({ switches: { faceRecognition: false, visionDescriptions: false, mic: false } });
    const saved = JSON.parse(readFileSync(process.env.TUBS_STATE_FILE!, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ faceRecognition: false, visionDescriptions: false, micOn: false, cameraOn: true });
    // A fresh start: env defaults, then the saved state.
    Object.assign(studioSettings, studioSettingsFromEnv({}));
    runtimeConfig.visionDescriptions = true;
    restoreState();
    expect(studioSettings).toMatchObject({ faceRecognition: false, micOn: false, cameraOn: true });
    expect(runtimeConfig.visionDescriptions).toBe(false);
  });
});
