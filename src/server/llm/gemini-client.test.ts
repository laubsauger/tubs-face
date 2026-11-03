import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamGeminiContent } from './gemini-client.js';

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
