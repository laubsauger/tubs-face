/**
 * One turn's streamed speech: decodes audio chunks, plays them back to back in
 * arrival order, and reports when the turn's audio has finished.
 *
 * Every source, timer and callback belongs to the session object. stop()
 * silences and forgets all of them, so nothing from an interrupted turn can
 * play late or end the next turn early. (This used to be ~20 variables shared
 * across turns, guarded by generation counters.)
 */

/** Wait after the last audio before calling it done, in case speak_end is still in flight. */
export const STREAMING_GAP_GRACE_MS = 280;
/** Give up waiting after this many grace periods (~11 s). */
export const STREAMING_FINALIZE_MAX_ATTEMPTS = 40;

export interface ScheduledChunk {
  index: number;
  decodedAt: number;
  /** AudioContext time the chunk starts. */
  scheduledAt: number;
  duration: number;
  /** AudioContext time when it was scheduled. */
  ctxTime: number;
  activeNodes: number;
}

export interface StreamingSession {
  readonly turnId: string | null;
  /** Queue one base64 audio chunk; chunks play in the order they were added. */
  addChunk(audioBase64: string): void;
  /** The server said the turn has no more audio (speak_end). */
  markEnd(): void;
  /** Silence everything now and ignore anything still decoding. */
  stop(): void;
  /** Chunks scheduled so far, for the debug timeline. */
  readonly scheduled: readonly ScheduledChunk[];
}

export interface StreamingSessionOptions {
  turnId: string | null;
  getContext: () => Promise<AudioContext>;
  decode: (context: AudioContext, audioBase64: string) => Promise<AudioBuffer>;
  /** All audio played after markEnd (or the wait timed out). Called once. */
  onFinished: () => void;
  onChunkScheduled?: (chunk: ScheduledChunk, buffer: AudioBuffer) => void;
  onError?: (message: string) => void;
  log?: (message: string) => void;
}

export function createStreamingSession(options: StreamingSessionOptions): StreamingSession {
  const { turnId, getContext, decode, onFinished } = options;
  const log = options.log ?? (() => {});
  const sources = new Set<AudioBufferSourceNode>();
  const timers = new Set<number>();
  const decoded = new Map<number, AudioBuffer>();
  const failed = new Set<number>();
  const scheduled: ScheduledChunk[] = [];
  let received = 0;
  let nextToSchedule = 0;
  let nextStartTime = 0;
  let activeNodes = 0;
  let endMarked = false;
  let finalizeTimer: number | null = null;
  let finalizeAttempts = 0;
  let stopped = false;
  let finished = false;
  let context: AudioContext | null = null;

  const later = (fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!stopped) fn();
    }, ms);
    timers.add(id);
    return id;
  };

  function finish(): void {
    if (finished || stopped) return;
    finished = true;
    clearFinalizeTimer();
    onFinished();
  }

  function clearFinalizeTimer(): void {
    if (finalizeTimer != null) {
      window.clearTimeout(finalizeTimer);
      timers.delete(finalizeTimer);
      finalizeTimer = null;
    }
  }

  function tryFinalize(): void {
    clearFinalizeTimer();
    finalizeTimer = later(() => {
      finalizeTimer = null;
      finalizeAttempts += 1;
      const pendingDecodes = received - nextToSchedule;
      if (finalizeAttempts >= STREAMING_FINALIZE_MAX_ATTEMPTS) {
        log(`forcing end after ${finalizeAttempts} waits | active=${activeNodes} | decoding=${pendingDecodes}`);
        finish();
        return;
      }
      if (pendingDecodes > 0 || activeNodes > 0) {
        tryFinalize();
        return;
      }
      finish();
    }, STREAMING_GAP_GRACE_MS);
  }

  function scheduleReady(): void {
    if (!context || stopped) return;
    while (decoded.has(nextToSchedule) || failed.has(nextToSchedule)) {
      if (failed.delete(nextToSchedule)) {
        nextToSchedule += 1;
        continue;
      }
      const buffer = decoded.get(nextToSchedule)!;
      decoded.delete(nextToSchedule);
      const index = nextToSchedule;
      nextToSchedule += 1;

      const now = context.currentTime;
      nextStartTime = Math.max(nextStartTime, now);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const scheduledAt = nextStartTime;
      activeNodes += 1;
      sources.add(source);
      source.start(scheduledAt);
      nextStartTime += buffer.duration;

      const chunk: ScheduledChunk = { index, decodedAt: performance.now(), scheduledAt, duration: buffer.duration, ctxTime: now, activeNodes };
      scheduled.push(chunk);
      options.onChunkScheduled?.(chunk, buffer);
      log(`chunk #${index} scheduled at ${scheduledAt.toFixed(3)} for ${buffer.duration.toFixed(3)}s`);

      let ended = false;
      const onEnded = () => {
        if (ended) return;
        ended = true;
        sources.delete(source);
        if (stopped) return;
        activeNodes = Math.max(0, activeNodes - 1);
        if (activeNodes > 0) return;
        if (endMarked && received === nextToSchedule) {
          finish();
        } else {
          // Out of audio but more may come (or speak_end is in flight).
          finalizeAttempts = 0;
          tryFinalize();
        }
      };
      source.onended = onEnded;
      // If the context is suspended (iOS autoplay), onended never fires.
      later(() => {
        if (!ended) {
          log(`chunk #${index} never ended (context ${context?.state}); counting it as done`);
          onEnded();
        }
      }, Math.max(0, (scheduledAt - now) * 1000) + buffer.duration * 1000 + 3000);
    }
  }

  return {
    turnId,
    scheduled,
    addChunk(audioBase64: string): void {
      if (stopped) return;
      clearFinalizeTimer();
      const index = received;
      received += 1;
      void (async () => {
        try {
          context ??= await getContext();
          if (context.state === 'suspended') await context.resume();
          const buffer = await decode(context, audioBase64);
          if (stopped) return;
          decoded.set(index, buffer);
          scheduleReady();
        } catch (error) {
          options.onError?.(`chunk #${index} decode failed: ${error instanceof Error ? error.message : String(error)}`);
          // Skip it so later chunks are not stuck behind a broken one.
          if (!stopped) {
            failed.add(index);
            scheduleReady();
          }
        }
      })();
    },
    markEnd(): void {
      if (stopped || finished) return;
      endMarked = true;
      finalizeAttempts = 0;
      tryFinalize();
    },
    stop(): void {
      stopped = true;
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      finalizeTimer = null;
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        source.disconnect();
      }
      sources.clear();
      decoded.clear();
    },
  };
}
