import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAMING_GAP_GRACE_MS, createStreamingSession } from './streaming-session.js';

// One turn of streamed speech. Order, clean finishing and a hard stop on
// interrupt are what the audience hears; these run against a fake AudioContext.

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(when: number) { this.startedAt = when; }
  stop() { this.stopped = true; }
}

class FakeContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async resume() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const context = new FakeContext();
  const decodes = new Map<string, ReturnType<typeof deferred<{ duration: number }>>>();
  const onFinished = vi.fn();
  const started: string[] = [];
  const session = createStreamingSession({
    onChunkStarted: (chunk) => started.push(`${chunk.text}@${chunk.scheduledAt}`),
    turnId: 't1',
    getContext: async () => context as unknown as AudioContext,
    decode: (_ctx, audio) => {
      const pending = deferred<{ duration: number }>();
      decodes.set(audio, pending);
      return pending.promise as unknown as Promise<AudioBuffer>;
    },
    onFinished,
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { context, decodes, onFinished, session, flush, started };
}

describe('createStreamingSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('plays chunks back to back in arrival order, even if they decode out of order', async () => {
    const { context, decodes, session, flush } = setup();
    session.addChunk('a');
    session.addChunk('b');
    await flush();
    decodes.get('b')!.resolve({ duration: 1 });
    await flush();
    expect(context.sources).toHaveLength(0); // b waits for a
    decodes.get('a')!.resolve({ duration: 2 });
    await flush();
    expect(context.sources.map((s) => [s.buffer?.duration, s.startedAt])).toEqual([[2, 0], [1, 2]]);
  });

  // Subtitles follow this: TTS delivers sentence two while sentence one is
  // still playing, and its words must not show before its audio starts.
  it('reports each chunk with its text when its audio starts, not when it arrives', async () => {
    const { decodes, session, flush, started } = setup();
    session.addChunk('a', 'First sentence.');
    session.addChunk('b', 'Second sentence.');
    await flush();
    decodes.get('a')!.resolve({ duration: 2 });
    decodes.get('b')!.resolve({ duration: 1 });
    await flush();
    expect(started).toEqual(['First sentence.@0']);
    await vi.advanceTimersByTimeAsync(1999);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(['First sentence.@0', 'Second sentence.@2']);
  });

  // Ming streams one reply in several chunks; the runtime keeps one subtitle
  // across them only if it learns which chunks continue the text.
  it('tells which scheduled chunks are continued by the next one', async () => {
    const context = new FakeContext();
    const scheduled: Array<[string, boolean]> = [];
    const session = createStreamingSession({
      turnId: 't1',
      getContext: async () => context as unknown as AudioContext,
      decode: async () => ({ duration: 1 }) as unknown as AudioBuffer,
      onFinished: () => {},
      onChunkScheduled: (chunk) => scheduled.push([chunk.text, chunk.more]),
    });
    session.addChunk('a', 'Whole reply.', true);
    session.addChunk('b', 'Whole reply.', true);
    session.addChunk('c', 'Whole reply.');
    session.addChunk('d', 'Next sentence.');
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduled).toEqual([['Whole reply.', true], ['Whole reply.', true], ['Whole reply.', false], ['Next sentence.', false]]);
  });

  it('reports no chunk starts after stop', async () => {
    const { decodes, session, flush, started } = setup();
    session.addChunk('a', 'First.');
    session.addChunk('b', 'Second.');
    await flush();
    decodes.get('a')!.resolve({ duration: 2 });
    decodes.get('b')!.resolve({ duration: 1 });
    await flush();
    session.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toEqual(['First.@0']);
  });

  it('finishes once, when the last chunk ends after speak_end', async () => {
    const { context, decodes, onFinished, session, flush } = setup();
    session.addChunk('a');
    await flush();
    decodes.get('a')!.resolve({ duration: 1 });
    await flush();
    session.markEnd();
    expect(onFinished).not.toHaveBeenCalled();
    context.sources[0]!.onended?.();
    await vi.advanceTimersByTimeAsync(STREAMING_GAP_GRACE_MS * 3);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('still finishes after a short grace period if speak_end never arrives', async () => {
    const { context, decodes, onFinished, session, flush } = setup();
    session.addChunk('a');
    await flush();
    decodes.get('a')!.resolve({ duration: 1 });
    await flush();
    context.sources[0]!.onended?.();
    await vi.advanceTimersByTimeAsync(STREAMING_GAP_GRACE_MS + 10);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('stop() silences playing audio and ignores chunks still decoding', async () => {
    const { context, decodes, onFinished, session, flush } = setup();
    session.addChunk('a');
    session.addChunk('b');
    await flush();
    decodes.get('a')!.resolve({ duration: 3 });
    await flush();
    session.stop();
    decodes.get('b')!.resolve({ duration: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]!.stopped).toBe(true);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('skips a chunk that fails to decode instead of stalling the rest', async () => {
    const { context, decodes, session, flush } = setup();
    session.addChunk('a');
    session.addChunk('b');
    session.addChunk('c');
    await flush();
    decodes.get('c')!.resolve({ duration: 1 });
    decodes.get('b')!.reject(new Error('corrupt'));
    decodes.get('a')!.resolve({ duration: 1 });
    await flush();
    expect(context.sources.map((s) => s.startedAt)).toEqual([0, 1]);
  });
});
