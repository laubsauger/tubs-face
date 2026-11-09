import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAMING_GAP_GRACE_MS, STREAM_LEAD_MARGIN_S, createStreamingSession, resetDeliveryRate, streamLeadSeconds, takeStreamingAudioStats } from './streaming-session.js';

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

  // Under GPU load Ming rendered at half speed and every piece came after the
  // one before had played: the line ended after the grace period, the late
  // audio started it again, and a hole sat inside the words every few seconds.
  describe('a Ming reply that arrives slower than it plays', () => {
    function ming(rate: number) {
      resetDeliveryRate(rate);
      takeStreamingAudioStats();
      const context = new FakeContext();
      const onFinished = vi.fn();
      const session = createStreamingSession({
        turnId: 't1',
        getContext: async () => context as unknown as AudioContext,
        decode: async () => ({ duration: 0.5 }) as unknown as AudioBuffer,
        onFinished,
        now: () => Date.now(),
      });
      /** Real-time passing: timers and the audio clock together. */
      const pass = async (ms: number) => {
        for (let t = 0; t < ms; t += 50) {
          context.currentTime += 0.05;
          await vi.advanceTimersByTimeAsync(50);
          for (const source of context.sources) {
            if (source.startedAt !== null && !source.stopped && source.buffer && context.currentTime >= source.startedAt + source.buffer.duration) {
              source.stopped = true;
              source.onended?.();
            }
          }
        }
      };
      return { context, onFinished, session, pass };
    }
    const REPLY = 'one two three four five six seven eight nine ten eleven twelve'; // 12 words, ~3.6 s

    afterEach(() => resetDeliveryRate());


    it('does not end the line while more of it was promised, however late it comes', async () => {
      const { context, onFinished, session, pass } = ming(Number.POSITIVE_INFINITY);
      session.addChunk('a', REPLY, true);
      await pass(1500); // the piece played out, and the next one is a second late
      expect(onFinished).not.toHaveBeenCalled();
      session.addChunk('b', REPLY, false);
      session.markEnd();
      await pass(1500);
      expect(context.sources).toHaveLength(2);
      expect(onFinished).toHaveBeenCalledTimes(1);
    });

    it('waits until enough is here to play through, then plays without a hole', async () => {
      const { context, session, pass } = ming(0.5);
      // A 0.5 s piece every second: half speed, as measured under load.
      for (let i = 0; i < 7; i += 1) {
        session.addChunk(String(i), REPLY, i < 6);
        await pass(1000);
      }
      await pass(4000);
      const starts = context.sources.map((source) => source.startedAt!);
      expect(starts).toHaveLength(7);
      // It held: nothing played until about half the reply was here.
      expect(starts[0]!).toBeGreaterThanOrEqual(streamLeadSeconds(3.6, 0.5) - STREAM_LEAD_MARGIN_S);
      // Then back to back: each piece starts where the one before ends.
      for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeCloseTo(0.5, 5);
      expect(takeStreamingAudioStats().underruns).toBe(0);
    });

    it('on the page\'s first reply, waits for a second piece to measure the rate, then plays', async () => {
      const { context, session, pass } = ming(Number.NaN);
      session.addChunk('a', REPLY, true);
      await pass(200);
      expect(context.sources).toHaveLength(0);
      session.addChunk('b', REPLY, true); // 0.5 s of audio in 0.25 s: faster than real time
      await pass(100);
      expect(context.sources).toHaveLength(2);
    });

    // In studio mode the next head's line is sent ahead, all of it at once
    // once Ming is done: a slow rate measured before must not hold a line that is all here.
    it('never holds a line whose audio is all here, however slow Ming was before', async () => {
      const { context, session, pass } = ming(0.3);
      session.addChunk('a', REPLY, true);
      session.addChunk('b', REPLY, true);
      session.addChunk('c', REPLY, false);
      await pass(50);
      expect(context.sources).toHaveLength(3);
      expect(context.sources[0]!.startedAt).toBeLessThan(0.1);
    });

    it('plays at once when the pieces come faster than real time', async () => {
      const { context, session, pass } = ming(1.7);
      session.addChunk('a', REPLY, true);
      await pass(50);
      expect(context.sources).toHaveLength(1);
      expect(context.sources[0]!.startedAt).toBeLessThan(0.1);
    });
  });
});
