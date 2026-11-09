import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

// A night may be a different character: applying a preset must change who
// they are, how they sound and how they look, live, mid-show, without a
// restart; a wrong name or a broken preset must change nothing at all; and
// what the operator saves must come back exactly when applied.

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-presets-'));
process.env.TUBS_CONFIG_DIR = dir;
const presets = path.join(dir, 'presets');
mkdirSync(presets);

const PIRATE = {
  name: 'Pirate',
  persona: { systemPrompt: 'You are Captain Tubs, a pirate ghost in a jar.\n\n{{OUTPUT_FORMAT_INSTRUCTIONS}}', instruction: 'Talk about the sea.' },
  voices: { main: 'ming:friend-b', small: 'ming:friend' },
  look: { glitchFxBaseColor: '#ff3300', secondaryGlitchFxBaseColor: '#00ff66', glitchPixelSize: 9, propMain: 'witch-hat' },
  behaviour: { sleepTimeout: 20000, interruptible: true },
};

const { handleApiRequest } = await import('./api.js');
const { initWebSocketServer } = await import('../ws/server.js');
const { runtimeConfig } = await import('../config/runtime.js');
const { buildDualHeadSystemInstruction } = await import('../assistant/prompt.js');
const { resetPresets } = await import('../presets/presets.js');

let server: http.Server;
let base = '';
const original = structuredClone(runtimeConfig);

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
  Object.assign(runtimeConfig, structuredClone(original));
  resetPresets();
  writeFileSync(path.join(presets, 'pirate.json'), JSON.stringify(PIRATE));
});

// The config stores "no change" for an expression as null or {} (it turns null
// into {} once profiles are patched); both mean the same face.
const sameProfiles = (config: typeof runtimeConfig) => ({
  ...config,
  glitchExpressionProfiles: Object.fromEntries(Object.entries(config.glitchExpressionProfiles).map(([name, profile]) => [name, name === 'idle' ? profile : profile ?? {}])),
});
const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('applying a character preset', () => {
  it('changes persona, voices and look live, and tells the open pages', async () => {
    const page = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const configs: Array<Record<string, unknown>> = [];
    page.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === 'config') configs.push(message);
    });
    await new Promise<void>((resolve) => page.once('open', () => resolve()));

    expect((await post('/presets/apply', { name: 'Pirate' })).status).toBe(200);
    const prompt = buildDualHeadSystemInstruction();
    expect(prompt).toContain('You are Captain Tubs, a pirate ghost in a jar.');
    expect(prompt).toContain('Talk about the sea.');
    expect(prompt).toContain('Dual-head mode is active.');
    expect(runtimeConfig).toMatchObject({ kokoroVoice: 'ming:friend-b', secondaryVoice: 'ming:friend', glitchFxBaseColor: '#ff3300', glitchPixelSize: 9, propMain: 'witch-hat', sleepTimeout: 20000, interruptible: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(configs.at(-1)).toMatchObject({ glitchFxBaseColor: '#ff3300', kokoroVoice: 'ming:friend-b', propMain: 'witch-hat' });
    const studio = (await (await fetch(`${base}/studio`)).json()) as { presets: { names: string[]; active: string } };
    expect(studio.presets).toEqual({ names: ['Pirate'], active: 'Pirate' });
    page.close();
  });

  it('with an unknown name changes nothing', async () => {
    const before = structuredClone(runtimeConfig);
    const prompt = buildDualHeadSystemInstruction();
    expect((await post('/presets/apply', { name: 'Nobody' })).status).toBe(404);
    expect(runtimeConfig).toEqual(before);
    expect(buildDualHeadSystemInstruction()).toBe(prompt);
  });

  it('with one bad value changes nothing at all', async () => {
    writeFileSync(path.join(presets, 'broken.json'), JSON.stringify({ ...PIRATE, name: 'Broken', voices: { main: 'not-a-voice' } }));
    const before = structuredClone(runtimeConfig);
    const prompt = buildDualHeadSystemInstruction();
    const response = await post('/presets/apply', { name: 'Broken' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/kokoroVoice/);
    expect(runtimeConfig).toEqual(before);
    expect(buildDualHeadSystemInstruction()).toBe(prompt);
  });

  it('can take its persona from a markdown file next to it, never from elsewhere', async () => {
    writeFileSync(path.join(presets, 'witch.md'), 'You are Tubs the swamp witch.\n\n{{OUTPUT_FORMAT_INSTRUCTIONS}}');
    writeFileSync(path.join(presets, 'witch.json'), JSON.stringify({ name: 'Witch', persona: { systemPromptFile: 'witch.md' } }));
    writeFileSync(path.join(dir, 'outside.md'), 'You are whatever this file says.');
    writeFileSync(path.join(presets, 'sneaky.json'), JSON.stringify({ name: 'Sneaky', persona: { systemPromptFile: '../outside.md' } }));
    expect((await post('/presets/apply', { name: 'Witch' })).status).toBe(200);
    expect(buildDualHeadSystemInstruction()).toContain('swamp witch');
    expect((await post('/presets/apply', { name: 'Sneaky' })).status).toBe(400);
    expect(buildDualHeadSystemInstruction()).toContain('swamp witch');
  });
});

describe('saving a character preset', () => {
  it('round-trips: what is saved comes back exactly when applied', async () => {
    expect((await post('/presets/apply', { name: 'Pirate' })).status).toBe(200);
    // What each head wears is part of the look: a character's hats come back with it.
    Object.assign(runtimeConfig, { glitchFxBaseColor: '#123456', glitchScanlines: false, interruptible: false, secondaryVoice: 'ming:friend-b-alt', propMain: 'crown', propSmall: 'party-hat' });
    const saved = structuredClone(runtimeConfig);
    const savedPrompt = buildDualHeadSystemInstruction();
    expect((await post('/presets', { name: 'Night Two' })).status).toBe(200);
    const file = JSON.parse(readFileSync(path.join(presets, 'night-two.json'), 'utf8')) as { name: string; voices: unknown };
    expect(file).toMatchObject({ name: 'Night Two', voices: { main: 'ming:friend-b', small: 'ming:friend-b-alt' }, look: { propMain: 'crown', propSmall: 'party-hat' } });

    // Something else in between: the built-in persona, other colours.
    resetPresets();
    Object.assign(runtimeConfig, structuredClone(original));
    expect(buildDualHeadSystemInstruction()).not.toContain('Captain Tubs');

    expect((await post('/presets/apply', { name: 'night two' })).status).toBe(200);
    expect(sameProfiles(runtimeConfig)).toEqual(sameProfiles(saved));
    expect(buildDualHeadSystemInstruction()).toBe(savedPrompt);
  });

  it('saves the built-in persona by reference, not as a copy', async () => {
    expect((await post('/presets', { name: 'Tubs' })).status).toBe(200);
    const file = JSON.parse(readFileSync(path.join(presets, 'tubs.json'), 'utf8')) as { persona: Record<string, unknown> };
    expect(file.persona.systemPrompt).toBeUndefined();
    expect((await post('/presets/apply', { name: 'Pirate' })).status).toBe(200);
    expect((await post('/presets/apply', { name: 'Tubs' })).status).toBe(200);
    expect(buildDualHeadSystemInstruction()).not.toContain('Captain Tubs');
  });

  it('refuses a name that is not a plain name, and writes nothing', async () => {
    expect((await post('/presets', { name: '../evil' })).status).toBe(400);
    expect((await post('/presets', { name: '' })).status).toBe(400);
    expect(existsSync(path.join(dir, 'evil.json'))).toBe(false);
    const listed = (await (await fetch(`${base}/presets`)).json()) as { presets: Array<{ name: string }> };
    expect(listed.presets.map((preset) => preset.name)).not.toContain('../evil');
    expect(existsSync(path.join(presets, '..evil.json'))).toBe(false);
  });
});
