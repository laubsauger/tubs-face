// Keeps one face stream published to the site node: WHIP, re-published with
// backoff whenever the session fails, drops or the site node restarts.

import { endSession, reconnectDelayMs, whipPublish, type WhipSession } from '../transport/whip.js';

export interface PublisherStatus {
  publishing: boolean;
  error?: string;
}

export interface FacePublisher {
  /** Publish to this WHIP URL (null: stop). Same URL again changes nothing. */
  publish(url: string | null): void;
  /** What the video sender did since the last call; null while not publishing. */
  stats(): Promise<PublishStats | null>;
  dispose(): void;
}

export interface PublishStats {
  /** Frames the canvas track delivered to WebRTC, per second. */
  sourceFps: number;
  /** Frames the encoder produced, per second. */
  encodedFps: number;
  keyFrames: number;
  /** What WebRTC says limits the stream: none, cpu, bandwidth or other. */
  limitedBy: string;
  encoder: string;
  encodeMsPerFrame: number;
  /** The width the encoder sends now (1024 unless WebRTC scaled it down). */
  frameWidth: number;
  /** Opus packets sent per second (50 at 20 ms each); fewer means the voice stalled. */
  audioPacketsPerSecond: number;
}

// 1024x1024 at 30 fps: plenty for a pixel face on a LAN. maintain-resolution
// lets the frame rate give first if it ever has to.
const MAX_BITRATE = 8_000_000;
const MAX_FRAMERATE = 30;
const DISCONNECT_GRACE_MS = 4000;
// Keyframes come when the site node asks (mediamtx: every 2 s, and on loss).
// Forcing more by switching the encoding off and on held a frame each time:
// a 60-150 ms stall in the stream about once a second, visible as a jump.

export function createFacePublisher(options: {
  /** The face's video and voice; null until the canvas exists. */
  stream: () => MediaStream | null;
  onStatus: (status: PublisherStatus) => void;
  log: (message: string) => void;
}): FacePublisher {
  let target: string | null = null;
  let session: WhipSession | null = null;
  let generation = 0;
  let attempt = 0;
  let retryTimer = 0;
  let dropTimer = 0;
  let disposed = false;
  let previous: { at: number; source: number; encoded: number; keys: number; encodeTime: number; audioPackets: number } | null = null;

  function status(next: PublisherStatus): void {
    options.onStatus(next);
  }

  function teardown(): void {
    window.clearTimeout(retryTimer);
    window.clearTimeout(dropTimer);
    if (session) {
      session.pc.onconnectionstatechange = null;
      session.pc.close();
      endSession(session.resource);
      session = null;
    }
  }

  function restart(): void {
    generation += 1;
    attempt = 0;
    teardown();
    if (!target || disposed) {
      status({ publishing: false });
      return;
    }
    void connect(generation);
  }

  function retry(gen: number, error: string): void {
    if (gen !== generation || disposed) return;
    teardown();
    const delay = reconnectDelayMs(attempt);
    attempt += 1;
    status({ publishing: false, error });
    options.log(`${error}; publishing again in ${(delay / 1000).toFixed(1)} s`);
    retryTimer = window.setTimeout(() => {
      if (gen === generation) void connect(gen);
    }, delay);
  }

  async function connect(gen: number): Promise<void> {
    const url = target;
    const stream = options.stream();
    if (!url) return;
    if (!stream || stream.getVideoTracks().length === 0) {
      retry(gen, 'face not rendering yet');
      return;
    }
    try {
      const next = await whipPublish(url, stream, { maxBitrate: MAX_BITRATE, maxFramerate: MAX_FRAMERATE });
      if (gen !== generation || disposed) {
        next.pc.close();
        endSession(next.resource);
        return;
      }
      session = next;
      options.log(`publishing to ${url}`);
      previous = null;
      next.pc.onconnectionstatechange = () => {
        if (gen !== generation) return;
        const state = next.pc.connectionState;
        if (state === 'connected') {
          window.clearTimeout(dropTimer);
          attempt = 0;
          status({ publishing: true });
        } else if (state === 'failed' || state === 'closed') {
          retry(gen, `stream ${state}`);
        } else if (state === 'disconnected') {
          window.clearTimeout(dropTimer);
          dropTimer = window.setTimeout(() => {
            if (gen === generation && next.pc.connectionState !== 'connected') retry(gen, 'stream dropped');
          }, DISCONNECT_GRACE_MS);
        }
      };
      if (next.pc.connectionState === 'connected') status({ publishing: true });
    } catch (error) {
      retry(gen, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    publish(url) {
      if (url === target) return;
      target = url;
      restart();
    },
    async stats() {
      const videoSender = session?.pc.getSenders().find((sender) => sender.track?.kind === 'video');
      const audioSender = session?.pc.getSenders().find((sender) => sender.track?.kind === 'audio');
      if (!videoSender) return null;
      const report = await videoSender.getStats();
      let audioPackets = 0;
      (await audioSender?.getStats())?.forEach((entry: Record<string, unknown>) => {
        if (entry.type === 'outbound-rtp') audioPackets = Number(entry.packetsSent ?? 0);
      });
      let source = 0;
      let encoded = 0;
      let keys = 0;
      let encodeTime = 0;
      let limitedBy = 'none';
      let encoder = '';
      let frameWidth = 0;
      report.forEach((entry: Record<string, unknown>) => {
        if (entry.type === 'media-source' && typeof entry.frames === 'number') source = entry.frames;
        if (entry.type === 'outbound-rtp') {
          encoded = Number(entry.framesEncoded ?? 0);
          keys = Number(entry.keyFramesEncoded ?? 0);
          encodeTime = Number(entry.totalEncodeTime ?? 0);
          limitedBy = String(entry.qualityLimitationReason ?? 'none');
          encoder = String(entry.encoderImplementation ?? '');
          frameWidth = Number(entry.frameWidth ?? 0);
        }
      });
      const now = performance.now();
      const last = previous;
      previous = { at: now, source, encoded, keys, encodeTime, audioPackets };
      if (!last) return null;
      const seconds = (now - last.at) / 1000;
      const frames = encoded - last.encoded;
      return {
        sourceFps: Math.round(((source - last.source) / seconds) * 10) / 10,
        encodedFps: Math.round((frames / seconds) * 10) / 10,
        keyFrames: keys - last.keys,
        limitedBy,
        encoder,
        encodeMsPerFrame: frames > 0 ? Math.round(((encodeTime - last.encodeTime) / frames) * 10_000) / 10 : 0,
        frameWidth,
        audioPacketsPerSecond: Math.round(((audioPackets - last.audioPackets) / seconds) * 10) / 10,
      };
    },
    dispose() {
      disposed = true;
      generation += 1;
      teardown();
    },
  };
}
