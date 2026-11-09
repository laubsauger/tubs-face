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

/**
 * Ming streams a reply in pieces as it renders. Under GPU load it renders
 * slower than it speaks (0.5x was measured), and piece after piece arrived
 * after the previous one had played: a 230-260 ms hole every few seconds,
 * inside words. So a reply that is still coming starts only once enough of it
 * is here to play through at the rate the pieces arrive. At normal speed
 * (faster than real time) that is at once.
 */
/**
 * Safety only: a reply that would need longer is played anyway. A pause before
 * a line reads as thinking; one in the middle of it as the voice breaking (an
 * 8 s cap, under a GPU at 95 %, gave a 3-6 s pause inside each line).
 */
export const STREAM_MAX_HOLD_MS = 30_000;
/** Extra audio held on top of the computed lead. */
export const STREAM_LEAD_MARGIN_S = 0.3;
/** For the length of a reply not all here yet: Ming speaks ~0.27-0.3 s per word. */
const SECONDS_PER_WORD = 0.3;
const HOLD_CHECK_MS = 100;

/** With no rate measured yet (the page's first reply), wait this long at most for a second piece to measure it. */
export const STREAM_FIRST_RATE_WAIT_MS = 1500;

// Audio seconds Ming delivers per second, as last measured (NaN: not yet); one TTS service per page.
let deliveryRate = Number.NaN;
// For the page's cadence report.
const audioStats = { underruns: 0, maxUnderrunMs: 0, heldMs: 0 };

/** What streamed speech did since the last call: holes inside a reply, time held back, Ming's rate. */
export function takeStreamingAudioStats(): { underruns: number; maxUnderrunMs: number; heldMs: number; deliveryRate: number | null } {
  const out = { ...audioStats, deliveryRate: Number.isFinite(deliveryRate) ? Math.round(deliveryRate * 100) / 100 : null };
  audioStats.underruns = 0;
  audioStats.maxUnderrunMs = 0;
  audioStats.heldMs = 0;
  return out;
}

/** Test helper: forget the measured rate (NaN), or set one. */
export function resetDeliveryRate(rate = Number.NaN): void {
  deliveryRate = rate;
}

/**
 * Seconds of audio to have in hand before playing a reply of `totalSeconds`
 * whose pieces arrive at `rate` audio seconds per second, so it never runs dry.
 */
export function streamLeadSeconds(totalSeconds: number, rate: number): number {
  if (!(rate < 1)) return 0;
  return Math.max(0, 1 - Math.max(0, rate)) * totalSeconds + STREAM_LEAD_MARGIN_S;
}

export interface ScheduledChunk {
  index: number;
  decodedAt: number;
  /** AudioContext time the chunk starts. */
  scheduledAt: number;
  duration: number;
  /** AudioContext time when it was scheduled. */
  ctxTime: number;
  activeNodes: number;
  /** What this chunk says (from the server), for subtitles. */
  text: string;
  /** The next chunk carries more audio for the same text (one subtitle across both). */
  more: boolean;
}

export interface StreamingSession {
  readonly turnId: string | null;
  /** Queue one base64 audio chunk; chunks play in the order they were added. */
  addChunk(audioBase64: string, text?: string, more?: boolean): void;
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
  /** A chunk's audio starts now (chunks are scheduled ahead of time). Not called after stop(). */
  onChunkStarted?: (chunk: ScheduledChunk) => void;
  /** Where sources connect (the lip-sync meter); the destination by default. */
  output?: (context: AudioContext) => AudioNode;
  onError?: (message: string) => void;
  log?: (message: string) => void;
  /** Wall clock in ms (tests). */
  now?: () => number;
}

export function createStreamingSession(options: StreamingSessionOptions): StreamingSession {
  const { turnId, getContext, decode, onFinished } = options;
  const log = options.log ?? (() => {});
  const wall = options.now ?? (() => performance.now());
  const sources = new Set<AudioBufferSourceNode>();
  const timers = new Set<number>();
  const decoded = new Map<number, AudioBuffer>();
  const failed = new Set<number>();
  const texts = new Map<number, { text: string; more: boolean }>();
  // Every chunk's text, whether more follows, its length and when it was here (decoded).
  const meta = new Map<number, { text: string; more: boolean; seconds?: number; at?: number }>();
  let holdSince: number | null = null;
  let holdTimer: number | null = null;
  let lastScheduledEnd = 0;
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
      // A reply that said more is coming is not over, however long the next piece takes.
      const promised = !endMarked && received > 0 && meta.get(received - 1)?.more === true;
      if (pendingDecodes > 0 || activeNodes > 0 || promised) {
        tryFinalize();
        return;
      }
      finish();
    }, STREAMING_GAP_GRACE_MS);
  }

  /** The chunk continues the one before it (same reply text, which said more was coming). */
  function continues(index: number): boolean {
    const before = meta.get(index - 1);
    const self = meta.get(index);
    return Boolean(before?.more && self && (!self.text || self.text === before.text));
  }

  function firstOfItem(index: number): number {
    let start = index;
    while (start > 0 && continues(start)) start -= 1;
    return start;
  }

  /** Audio seconds per second at which this reply's pieces have been arriving; null with one piece. */
  function itemRate(start: number): number | null {
    const first = meta.get(start);
    if (first?.at === undefined) return null;
    let seconds = 0;
    let lastAt = first.at;
    for (let i = start + 1; continues(i) && meta.get(i)?.at !== undefined; i += 1) {
      seconds += meta.get(i)!.seconds ?? 0;
      lastAt = Math.max(lastAt, meta.get(i)!.at!);
    }
    const elapsed = (lastAt - first.at) / 1000;
    return seconds > 0 && elapsed >= 0.2 ? seconds / elapsed : null;
  }

  /**
   * Whether the reply starting (or running dry) at nextToSchedule should wait
   * for more of itself: only while more is coming and too little is here.
   */
  function shouldHold(now: number): boolean {
    const head = meta.get(nextToSchedule);
    // The server said the reply is over: play what came.
    if (!head?.more || endMarked) return false;
    const dry = !context || nextStartTime <= context.currentTime + 0.005;
    const start = firstOfItem(nextToSchedule);
    if (start !== nextToSchedule && !dry) return false;
    // In hand: this piece and the pieces after it that are here, up to the reply's end.
    let buffered = 0;
    for (let i = nextToSchedule; decoded.has(i); i += 1) {
      buffered += decoded.get(i)!.duration;
      if (!meta.get(i)?.more) return false; // the whole rest of the reply is here
    }
    let played = 0;
    for (let i = start; i < nextToSchedule; i += 1) played += meta.get(i)?.seconds ?? 0;
    const words = (head.text.trim().match(/\S+/g) ?? []).length;
    const remaining = Math.max(buffered, words * SECONDS_PER_WORD - played);
    const rate = itemRate(start) ?? deliveryRate;
    holdSince ??= now;
    // Nothing measured yet: wait for a second piece to tell how fast they come.
    if (Number.isNaN(rate)) return now - holdSince < STREAM_FIRST_RATE_WAIT_MS;
    const need = streamLeadSeconds(remaining, rate);
    return buffered < need && now - holdSince < STREAM_MAX_HOLD_MS;
  }

  function scheduleReady(): void {
    if (!context || stopped) return;
    while (decoded.has(nextToSchedule) || failed.has(nextToSchedule)) {
      if (failed.delete(nextToSchedule)) {
        nextToSchedule += 1;
        continue;
      }
      const wallNow = wall();
      if (shouldHold(wallNow)) {
        if (holdTimer == null) {
          holdTimer = later(() => {
            holdTimer = null;
            scheduleReady();
          }, HOLD_CHECK_MS);
        }
        return;
      }
      if (holdSince != null) {
        const held = wallNow - holdSince;
        audioStats.heldMs += held;
        log(`held a reply ${Math.round(held)} ms for more of it (rate ${Number.isNaN(deliveryRate) ? 'unknown' : `${deliveryRate.toFixed(2)}x`})`);
        holdSince = null;
      }
      const buffer = decoded.get(nextToSchedule)!;
      decoded.delete(nextToSchedule);
      const index = nextToSchedule;
      nextToSchedule += 1;

      const now = context.currentTime;
      // A piece of the same reply after the one before has already played out: a hole in the speech.
      if (continues(nextToSchedule) && lastScheduledEnd > 0 && now > lastScheduledEnd + 0.005) {
        const hole = (now - lastScheduledEnd) * 1000;
        audioStats.underruns += 1;
        audioStats.maxUnderrunMs = Math.max(audioStats.maxUnderrunMs, Math.round(hole));
      }
      nextStartTime = Math.max(nextStartTime, now);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(options.output?.(context) ?? context.destination);
      const scheduledAt = nextStartTime;
      activeNodes += 1;
      sources.add(source);
      source.start(scheduledAt);
      nextStartTime += buffer.duration;
      lastScheduledEnd = nextStartTime;

      const { text = '', more = false } = texts.get(index) ?? {};
      const chunk: ScheduledChunk = { index, decodedAt: performance.now(), scheduledAt, duration: buffer.duration, ctxTime: now, activeNodes, text, more };
      texts.delete(index);
      scheduled.push(chunk);
      options.onChunkScheduled?.(chunk, buffer);
      if (options.onChunkStarted) {
        const started = options.onChunkStarted;
        later(() => started(chunk), Math.max(0, (scheduledAt - now) * 1000));
      }
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
    addChunk(audioBase64: string, text = '', more = false): void {
      if (stopped) return;
      clearFinalizeTimer();
      const index = received;
      received += 1;
      texts.set(index, { text, more });
      meta.set(index, { text, more });
      void (async () => {
        try {
          context ??= await getContext();
          if (context.state === 'suspended') await context.resume();
          const buffer = await decode(context, audioBase64);
          if (stopped) return;
          decoded.set(index, buffer);
          const entry = meta.get(index);
          if (entry) {
            entry.seconds = buffer.duration;
            entry.at = wall();
          }
          const rate = itemRate(firstOfItem(index));
          if (rate !== null) deliveryRate = rate;
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
