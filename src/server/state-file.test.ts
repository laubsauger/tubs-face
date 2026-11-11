import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// On a studio Mac studio-manager restarts tubs-face when it must. The night's
// character, the relationships toggle, the vision provider, the mic and
// picture sources and what each head wears come back as the operator left
// them, from a local file that never holds a key.

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-state-'));
const file = path.join(dir, 'tubs-state.json');
process.env.TUBS_STATE_FILE = file;
process.env.TUBS_CONFIG_DIR = dir;
mkdirSync(path.join(dir, 'presets'));
writeFileSync(path.join(dir, 'presets', 'pirate.json'), JSON.stringify({ name: 'Pirate', look: { glitchFxBaseColor: '#ff3300' } }));

let server: http.Server;
let base = '';
beforeAll(async () => {
  const { handleApiRequest } = await import('./routes/api.js');
  server = http.createServer((request, response) => void handleApiRequest(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the studio state file', () => {
  it('keeps the operator\'s choices as they change, and never the vision key', async () => {
    expect((await post('/presets/apply', { name: 'Pirate' })).status).toBe(200);
    expect((await post('/config', { relationshipsEnabled: false, visionProvider: 'openai', visionModel: 'qwen3-vl:4b-instruct', visionBaseUrl: 'http://127.0.0.1:11434/v1', visionApiKey: 'secret-key-123', propSmall: 'crown' })).status).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ preset: 'Pirate', visionProvider: 'openai', relationshipsEnabled: false });
    expect((await post('/studio', { micSource: 'site:mic-1', visionSource: 'snapshot:http://127.0.0.1:7000/color.jpg' })).status).toBe(200);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      preset: 'Pirate',
      relationshipsEnabled: false,
      visionProvider: 'openai',
      visionModel: 'qwen3-vl:4b-instruct',
      visionBaseUrl: 'http://127.0.0.1:11434/v1',
      micSource: 'site:mic-1',
      visionSource: 'snapshot:http://127.0.0.1:7000/color.jpg',
      propMain: 'none',
      propSmall: 'crown',
    });
    expect(readFileSync(file, 'utf8')).not.toContain('secret-key-123');
  });

  it('brings them back after a restart', async () => {
    vi.resetModules();
    const { restoreState } = await import('./state-file.js');
    const { runtimeConfig } = await import('./config/runtime.js');
    const { studioSettings } = await import('./studio/state.js');
    const { listPresets } = await import('./presets/presets.js');
    // A fresh start: defaults and env only.
    expect(runtimeConfig.relationshipsEnabled).toBe(true);
    expect(restoreState()).toEqual(expect.arrayContaining(['preset Pirate', 'relationshipsEnabled', 'visionProvider', 'micSource', 'visionSource', 'propSmall']));
    expect(runtimeConfig).toMatchObject({ relationshipsEnabled: false, visionProvider: 'openai', visionModel: 'qwen3-vl:4b-instruct', glitchFxBaseColor: '#ff3300', propSmall: 'crown' });
    expect(studioSettings).toMatchObject({ micSource: 'site:mic-1', visionSource: 'snapshot:http://127.0.0.1:7000/color.jpg' });
    expect(listPresets().active).toBe('Pirate');
  });

  // Seen 11 Nov 2026: vision descriptions left on (and restored at every start) ate the budget; every
  // provider is paid per picture. They start off by default and a saved "on" is never restored.
  it('never starts with paid vision descriptions on, whatever was saved', async () => {
    writeFileSync(file, JSON.stringify({ visionProvider: 'gemini', visionDescriptions: true, relationshipsEnabled: false }));
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { restoreState } = await import('./state-file.js');
    const { runtimeConfig } = await import('./config/runtime.js');
    expect(runtimeConfig.visionDescriptions).toBe(false);   // the default
    const restored = restoreState();
    expect(restored).not.toContain('visionDescriptions');
    expect(runtimeConfig).toMatchObject({ visionProvider: 'gemini', visionDescriptions: false, relationshipsEnabled: false });
    vi.restoreAllMocks();
  });

  it('starts on defaults from a broken file, and skips a value that is no longer valid', async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(file, '{ not json');
    const first = await import('./state-file.js');
    expect(first.restoreState()).toEqual([]);
    vi.resetModules();
    writeFileSync(file, JSON.stringify({ visionProvider: 'claude', micSource: 'local' }));
    const second = await import('./state-file.js');
    expect(second.restoreState()).toEqual(['micSource']);
    vi.restoreAllMocks();
  });

  it('is off without TUBS_STATE_FILE: nothing written, nothing read', async () => {
    vi.resetModules();
    const before = process.env.TUBS_STATE_FILE;
    process.env.TUBS_STATE_FILE = '';
    const other = path.join(dir, 'never.json');
    const { persistState, restoreState, stateFilePath } = await import('./state-file.js');
    expect(stateFilePath()).toBeNull();
    persistState();
    expect(restoreState()).toEqual([]);
    expect(existsSync(other)).toBe(false);
    process.env.TUBS_STATE_FILE = before;
  });
});
