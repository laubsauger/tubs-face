import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRuntimeConfigPatch, runtimeConfig } from '../config/runtime.js';
import { getVisualContext, updateVisualContext } from './context.js';
import { VISION_PROMPT, VISION_SYSTEM, createVisionService } from './vision.js';

// docs/vision.md. Vision is one of the main running costs, so who looks at
// the pictures is a setting (off, Gemini, or any OpenAI-compatible server on
// our own GPUs), switchable live, under a budget, and a slow or broken
// provider must never cost Tubs what he already saw, or hold up a reply.

interface Received { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }

/** An OpenAI-compatible server (Ollama's /v1, llama-server, vLLM) that answers with a fixed description. */
function stubOpenAi(answer: { text?: string; status?: number; delayMs?: number } = {}) {
  const requests: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      requests.push({ path: request.url ?? '', headers: request.headers, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: answer.text ?? 'Left: a red coat. Right: a blue cap.' } }], usage: { prompt_tokens: 600, completion_tokens: 20 } }));
      }, answer.delayMs ?? 0);
    });
  });
  return {
    requests,
    server,
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const FRAME = `data:image/jpeg;base64,${Buffer.from('a jpeg, scaled by the face page').toString('base64')}`;

let snapshot: typeof runtimeConfig;
beforeEach(() => {
  snapshot = structuredClone(runtimeConfig);
  updateVisualContext('', 0);
});
afterEach(() => {
  Object.assign(runtimeConfig, snapshot);
});

describe('vision through an OpenAI-compatible server', () => {
  const stub = stubOpenAi();
  let base = '';
  beforeAll(async () => { base = await stub.start(); });
  afterAll(() => stub.stop());

  it('sends the picture as an image_url data URL to {base}/chat/completions, with the same prompt as for Gemini', async () => {
    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: base, visionModel: 'qwen3-vl:4b' });
    const vision = createVisionService({ log: () => {} });
    vision.setApiKey('local-key');
    stub.requests.length = 0;
    expect(await vision.look(FRAME, 'appearance')).toBe('Left: a red coat. Right: a blue cap.');
    const [request] = stub.requests;
    expect(request!.path).toBe('/v1/chat/completions');
    expect(request!.headers.authorization).toBe('Bearer local-key');
    expect(request!.body).toMatchObject({
      model: 'qwen3-vl:4b',
      messages: [
        { role: 'system', content: VISION_SYSTEM },
        { role: 'user', content: [{ type: 'text', text: VISION_PROMPT }, { type: 'image_url', image_url: { url: FRAME } }] },
      ],
    });
    // What Tubs gets to know for his next reply.
    expect(getVisualContext()).toBe('Left: a red coat. Right: a blue cap.');
  });

  it('counts the calls, latency and tokens in /stats, apart from the LLM', async () => {
    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: base, visionModel: 'm' });
    const vision = createVisionService({ log: () => {} });
    await vision.look(FRAME, 'refresh');
    await vision.look(FRAME, 'refresh');
    const stats = vision.stats();
    expect(stats).toMatchObject({ provider: 'openai', model: 'm', calls: 2, failures: 0, usedThisHour: 2, baseUrl: base });
    expect(stats.byProvider.openai).toMatchObject({ calls: 2, tokensIn: 1200, tokensOut: 40 });
    expect(stats.byProvider.gemini.calls).toBe(0);
    expect(stats.avgLatencyMs).not.toBeNull();
  });
});

describe('the vision prompt', () => {
  // Field notes and Tubs's remarks rely on Left:/Middle:/Right: to tell people
  // apart; with one person a label made the model invent "Right: no other people".
  it('asks for position labels only with several people, and keeps the rules', () => {
    expect(VISION_PROMPT).toMatch(/only one person[^.]*no label/i);
    expect(VISION_PROMPT).toMatch(/two or more people[^.]*Left:, Middle: or Right:/);
    expect(VISION_PROMPT).toContain('Never mention people who are not there.');
    expect(VISION_PROMPT).toContain('no judgments, no guesses about age, body, ethnicity or gender. Under 60 words.');
  });
});

describe('a model that answers with no text (a thinking model)', () => {
  it('counts as a failure and keeps the last description', async () => {
    const stub = stubOpenAi({ text: '' });
    const base = await stub.start();
    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: base, visionModel: 'qwen3-vl:4b' });
    updateVisualContext('Middle: a green scarf.');
    const logs: string[] = [];
    const vision = createVisionService({ log: (line) => logs.push(line) });
    expect(await vision.look(FRAME, 'refresh')).toBeNull();
    expect(getVisualContext()).toBe('Middle: a green scarf.');
    expect(vision.stats()).toMatchObject({ calls: 1, failures: 1 });
    expect(logs.join('\n')).toMatch(/no text.*-instruct/);
    await stub.stop();
  });
});

describe('vision off', () => {
  it('sends no picture anywhere, for a new visitor or a refresh', async () => {
    const stub = stubOpenAi();
    const base = await stub.start();
    let geminiCalls = 0;
    applyRuntimeConfigPatch({ visionProvider: 'off', visionBaseUrl: base, visionModel: 'm' });
    const vision = createVisionService({ log: () => {}, deps: { gemini: async () => { geminiCalls += 1; return { text: 'x', usage: {}, model: 'g' }; } } });
    expect(await vision.look(FRAME, 'appearance')).toBeNull();
    expect(await vision.look(FRAME, 'refresh')).toBeNull();
    expect(stub.requests).toHaveLength(0);
    expect(geminiCalls).toBe(0);
    expect(vision.stats().skipped.off).toBe(2);
    await stub.stop();
  });
});

describe('a slow vision provider', () => {
  it('gives up after visionTimeoutMs and keeps the last description', async () => {
    const stub = stubOpenAi({ delayMs: 3000 });
    const base = await stub.start();
    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: base, visionModel: 'm', visionTimeoutMs: 500 });
    updateVisualContext('Middle: a green scarf.');
    const vision = createVisionService({ log: () => {} });
    const started = Date.now();
    expect(await vision.look(FRAME, 'refresh')).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(getVisualContext()).toBe('Middle: a green scarf.');
    expect(vision.stats()).toMatchObject({ calls: 1, failures: 1 });
    await stub.stop();
  });
});

describe('switching the vision provider live', () => {
  it('takes effect on the next picture, without a restart', async () => {
    const stub = stubOpenAi();
    const base = await stub.start();
    const gemini: string[] = [];
    const vision = createVisionService({
      log: () => {},
      deps: { gemini: async (args) => { gemini.push(args.model); return { text: 'Gemini saw a hat.', usage: { promptTokenCount: 300, candidatesTokenCount: 10 }, model: args.model }; } },
    });
    applyRuntimeConfigPatch({ visionProvider: 'gemini', visionModel: '' });
    expect(await vision.look(FRAME, 'refresh')).toBe('Gemini saw a hat.');
    // Gemini without a vision model of its own uses the chat model, as before.
    expect(gemini).toEqual([runtimeConfig.llmModel]);

    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: base, visionModel: 'qwen3-vl:4b' });
    expect(await vision.look(FRAME, 'refresh')).toBe('Left: a red coat. Right: a blue cap.');
    expect(stub.requests).toHaveLength(1);

    applyRuntimeConfigPatch({ visionProvider: 'off' });
    expect(await vision.look(FRAME, 'refresh')).toBeNull();
    expect(stub.requests).toHaveLength(1);
    expect(gemini).toHaveLength(1);
    await stub.stop();
  });

  it('refuses a provider or base URL it cannot use, and changes nothing', () => {
    expect(() => applyRuntimeConfigPatch({ visionProvider: 'claude' as never })).toThrow(/visionProvider/);
    expect(() => applyRuntimeConfigPatch({ visionBaseUrl: 'ftp://x' })).toThrow(/visionBaseUrl/);
    expect(runtimeConfig.visionProvider).toBe(snapshot.visionProvider);
    applyRuntimeConfigPatch({ visionBaseUrl: 'fleet:vision' });
    expect(runtimeConfig.visionBaseUrl).toBe('fleet:vision');
  });
});

describe('the vision budget in the pipeline', () => {
  it('holds the hourly cap and pauses refreshes while asleep, but still looks at a new visitor', async () => {
    const stub = stubOpenAi();
    const base = await stub.start();
    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: base, visionModel: 'm', visionMaxPerHour: 2, visionWhileAsleep: false });
    const vision = createVisionService({ log: () => {} });
    vision.noteSleeping(true);
    expect(await vision.look(FRAME, 'refresh')).toBeNull();
    expect(await vision.look(FRAME, 'appearance')).not.toBeNull();
    vision.noteSleeping(false);
    expect(await vision.look(FRAME, 'refresh')).not.toBeNull();
    expect(await vision.look(FRAME, 'refresh')).toBeNull();
    expect(stub.requests).toHaveLength(2);
    expect(vision.stats().skipped).toEqual({ off: 0, asleep: 1, cap: 1 });
    await stub.stop();
  });
});

describe('fleet:vision through the hub', () => {
  it('uses the box the hub ranks first, and the next one once it fails', async () => {
    const broken = stubOpenAi({ status: 500 });
    const working = stubOpenAi({ text: 'Right: a yellow raincoat.' });
    const brokenBase = await broken.start();
    const workingBase = await working.start();
    const hub = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ providers: [
        { id: 'busy/vision', serverBase: brokenBase.replace(/\/v1$/, '') },
        { id: 'idle/vision', serverBase: workingBase.replace(/\/v1$/, '') },
      ] }));
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
    applyRuntimeConfigPatch({ visionProvider: 'openai', visionBaseUrl: 'fleet:vision', visionModel: 'm' });
    const vision = createVisionService({ log: () => {}, hub: hubUrl });
    expect(await vision.look(FRAME, 'refresh')).toBeNull();
    expect(broken.requests).toHaveLength(1);
    expect(await vision.look(FRAME, 'refresh')).toBe('Right: a yellow raincoat.');
    expect(working.requests).toHaveLength(1);
    await Promise.all([broken.stop(), working.stop(), new Promise<void>((resolve) => hub.close(() => resolve()))]);
  });
});
