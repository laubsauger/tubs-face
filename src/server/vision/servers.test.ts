import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VisionModelsResponse, VisionServersResponse, VisionTestResult } from '../../shared/contracts/vision.js';

// The Studio tab lets someone who doesn't know base URLs or model tags pick
// "Ollama on this Mac" or a box on the network, and a model from what that
// box has. The thinking variants are the trap (qwen3-vl:4b answers nothing:
// every token goes to thinking), so they are flagged with the -instruct one
// to use. A hub or server that does not answer must read as "not there", not
// break the tab.

interface Stub {
  url: string;
  close(): Promise<void>;
}

async function stub(answer: (request: http.IncomingMessage, body: string) => { status: number; body: unknown }): Promise<Stub> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      const reply = answer(request, body);
      response.writeHead(reply.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function gone(): Promise<string> {
  const closed = await stub(() => ({ status: 200, body: {} }));
  await closed.close();
  return closed.url;
}

// The hub the vision service asks for fleet:vision: nobody there.
process.env.FLEET_HUB = await gone();
const { visionModels, visionServers, thinkingWarning } = await import('./servers.js');
const { handleApiRequest } = await import('../routes/api.js');

let api: http.Server;
let apiBase = '';
let openai: Stub;
let lastPrompt: unknown = null;

beforeAll(async () => {
  openai = await stub((request, body) => {
    if (request.url === '/v1/models') return { status: 200, body: { data: [{ id: 'qwen3-vl:4b' }, { id: 'qwen3-vl:4b-instruct' }, { id: 'llava:7b' }] } };
    if (request.url === '/v1/chat/completions') {
      lastPrompt = JSON.parse(body);
      return { status: 200, body: { choices: [{ message: { content: 'A person in a red coat.' } }], usage: { prompt_tokens: 10, completion_tokens: 6 } } };
    }
    return { status: 404, body: {} };
  });
  api = http.createServer((request, response) => {
    void handleApiRequest(request, response);
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await openai.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe('the models a server has', () => {
  it('flags the thinking variant and names the -instruct one to use', async () => {
    const listed = await visionModels(`${openai.url}/v1`);
    expect(listed.models).toEqual([
      { id: 'llava:7b' },
      { id: 'qwen3-vl:4b', warning: expect.stringContaining('empty answer') },
      { id: 'qwen3-vl:4b-instruct' },
    ]);
    expect(listed.suggested).toBe('qwen3-vl:4b-instruct');
    expect(thinkingWarning('magistral-small-thinking')).toBeTruthy();
    expect(thinkingWarning('gemma3:4b')).toBeUndefined();
  });

  it('come from Ollama\'s own list when its OpenAI side has none, and say so when nothing answers', async () => {
    const ollama = await stub((request) => (request.url === '/api/tags' ? { status: 200, body: { models: [{ name: 'qwen3-vl:4b' }] } } : { status: 404, body: {} }));
    try {
      const listed = await visionModels(`${ollama.url}/v1`);
      expect(listed.models.map((model) => model.id)).toEqual(['qwen3-vl:4b']);
      // Not installed, but it is what to pull.
      expect(listed.suggested).toBe('qwen3-vl:4b-instruct');
    } finally {
      await ollama.close();
    }
    const nowhere = await visionModels(`${await gone()}/v1`);
    expect(nowhere).toMatchObject({ models: [], error: expect.stringContaining('no model list') });
  });
});

describe('the servers to pick from', () => {
  it('are Ollama here, the fleet, and each fleet vision box by name', async () => {
    const hub = await stub((request) => (request.url?.startsWith('/api/fleet/providers') ? {
      status: 200,
      body: { providers: [{ id: 'msi/vision', label: 'vision · msi', serverBase: 'http://msi.tail:11434', lanBases: ['http://192.168.1.40:11434'], healthy: true }] },
    } : { status: 404, body: {} }));
    try {
      const listed = await visionServers(hub.url);
      expect(listed.servers).toEqual([
        { label: 'Ollama on this machine', baseUrl: 'http://127.0.0.1:11434/v1', healthy: null },
        { label: 'Ollama via the fleet (the hub picks a box)', baseUrl: 'fleet:vision', healthy: null },
        { label: 'vision · msi', baseUrl: 'http://192.168.1.40:11434/v1', healthy: true },
      ]);
    } finally {
      await hub.close();
    }
  });

  it('are the presets alone, with the reason, when the hub does not answer', async () => {
    const listed = await visionServers(await gone());
    expect(listed.servers.map((server) => server.baseUrl)).toEqual(['http://127.0.0.1:11434/v1', 'fleet:vision']);
    expect(listed.problem).toContain('does not answer');
  });
});

describe('the routes', () => {
  const picture = `data:image/jpeg;base64,${Buffer.from('a picture').toString('base64')}`;
  const test = (body: unknown, headers: Record<string, string> = {}) => fetch(`${apiBase}/vision/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  it('list models for fleet:vision with no box found as none, not as a crash', async () => {
    const response = await fetch(`${apiBase}/vision/models?base=fleet:vision`);
    expect(response.status).toBe(200);
    expect((await response.json()) as VisionModelsResponse).toMatchObject({ base: 'fleet:vision', models: [], error: expect.stringContaining('no vision box') });
    expect((await fetch(`${apiBase}/vision/models?base=file:///etc/passwd`)).status).toBe(400);
    expect(((await (await fetch(`${apiBase}/vision/servers`)).json()) as VisionServersResponse).servers.length).toBeGreaterThanOrEqual(2);
  });

  it('test one picture against the chosen server and model: latency, where, the answer', async () => {
    const result = (await (await test({ provider: 'openai', model: 'qwen3-vl:4b-instruct', baseUrl: `${openai.url}/v1`, frame: picture })).json()) as VisionTestResult;
    expect(result).toMatchObject({ ok: true, where: openai.url.replace('http://', ''), text: 'A person in a red coat.' });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(lastPrompt)).toContain(picture);
    // No box found for fleet:vision: a clear failure, not a crash.
    const fleet = (await (await test({ provider: 'openai', model: 'x', baseUrl: 'fleet:vision', frame: picture })).json()) as VisionTestResult;
    expect(fleet).toMatchObject({ ok: false, error: expect.stringContaining('fleet:vision') });
  });

  it('take a test only from the dashboard itself, as JSON', async () => {
    expect((await test({ provider: 'openai', model: 'x', baseUrl: `${openai.url}/v1`, frame: picture }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const form = await fetch(`${apiBase}/vision/test`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(403);
    expect((await test({ provider: 'openai', model: 'x', baseUrl: `${openai.url}/v1` })).status).toBe(400);
  });
});
