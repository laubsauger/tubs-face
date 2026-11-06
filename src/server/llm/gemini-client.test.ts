import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamGeminiContent, warmGeminiConnection } from './gemini-client.js';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of chunks) {
        const event = { candidates: [{ content: { parts: [{ text }] } }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// Streamed text goes straight to the sentence splitter and then to TTS. Gemini
// often splits a word boundary across chunks, so dropping the boundary space
// makes TTS read "isjust" and "andadd".
describe('streamGeminiContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the spaces at chunk boundaries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['Fun is', ' just a chemical distraction and', ' zip ties.'])));
    const deltas: string[] = [];

    const result = await streamGeminiContent({
      apiKey: 'test-key',
      model: 'test-model',
      systemInstruction: 'test',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      maxOutputTokens: 64,
      onChunk: (delta) => deltas.push(delta),
    });

    expect(result.text).toBe('Fun is just a chemical distraction and zip ties.');
    expect(deltas.join('')).toBe(result.text);
  });

  // Newer Flash models (3.7+) reject thinking level MINIMAL with a 400. The
  // turn must still work, and later turns should not pay for a failed request.
  it('retries with thinking level LOW when the model rejects MINIMAL, and remembers it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const levels: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const level = JSON.parse(String(init.body)).generationConfig.thinkingConfig.thinkingLevel as string;
      levels.push(level);
      if (level === 'MINIMAL') {
        return new Response(JSON.stringify({ error: { message: 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.' } }), { status: 400 });
      }
      return sseResponse(['Still ', 'works.']);
    }));
    const args = {
      apiKey: 'test-key',
      model: 'gemini-future-flash',
      systemInstruction: 'test',
      contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
      maxOutputTokens: 64,
      onChunk: () => {},
    };

    expect((await streamGeminiContent(args)).text).toBe('Still works.');
    expect((await streamGeminiContent(args)).text).toBe('Still works.');
    expect(levels).toEqual(['MINIMAL', 'LOW', 'LOW']);
  });
});

// The warm-up runs on every voice clip, before anyone knows if a reply follows.
// It must never carry the API key, and it must be a request Google answers
// without closing the connection, or it warms nothing.
describe('warmGeminiConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the connection with a keyless GET on the API path, not a HEAD on the bare host', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    warmGeminiConnection();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models$/);
    expect(url).not.toContain('key=');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('never throws when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(() => warmGeminiConnection()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
