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
  const session = createStreamingSession({
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
  return { context, decodes, onFinished, session, flush };
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
