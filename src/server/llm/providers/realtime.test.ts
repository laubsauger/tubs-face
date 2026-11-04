import { afterEach, describe, expect, it, vi } from 'vitest';
import { realtimeProvider } from './realtime.js';

// A local Ollama answers through the speech service as NDJSON. Streaming it
// is what lets Tubs start speaking after the first sentence instead of after
// the whole reply.

function ndjson(lines: unknown[], splitAt?: number): Response {
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  const parts = splitAt ? [text.slice(0, splitAt), text.slice(splitAt)] : [text];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const args = { model: 'llama3', systemInstruction: 'Be Tubs.', contents: [], maxOutputTokens: 100 };

describe('Ollama provider streaming', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hands each delta over as it arrives, even when a line is split across reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([{ delta: 'Nice ' }, { delta: 'hat.' }, { done: true, model: 'llama3:8b', usage: { promptTokenCount: 9 } }], 12)));
    const deltas: string[] = [];
    const result = await realtimeProvider.streamContent!({ ...args, onChunk: (delta) => deltas.push(delta) });
    expect(deltas).toEqual(['Nice ', 'hat.']);
    expect(result).toMatchObject({ text: 'Nice hat.', model: 'llama3:8b', aborted: false, usage: { promptTokenCount: 9 } });
  });

  it('surfaces a model error instead of returning an empty reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([{ error: 'model not found', done: true }])));
    await expect(realtimeProvider.streamContent!({ ...args, onChunk: () => {} })).rejects.toThrow(/model not found/);
  });

  it('reports an interrupted stream as aborted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return ndjson([]);
    }));
    const controller = new AbortController();
    controller.abort();
    const result = await realtimeProvider.streamContent!({ ...args, onChunk: () => {}, abortSignal: controller.signal });
    expect(result.aborted).toBe(true);
  });
});
