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
  dispose(): void;
}

// 1024x1024 at 30 fps: plenty for a pixel face on a LAN. maintain-resolution
// lets the frame rate give first if it ever has to.
const MAX_BITRATE = 8_000_000;
const MAX_FRAMERATE = 30;
const DISCONNECT_GRACE_MS = 4000;
/** The contract wants a keyframe at least every second; a little early leaves room for the check interval. */
export const MAX_KEYFRAME_GAP_MS = 800;
const KEYFRAME_CHECK_MS = 100;

/**
 * Keeps keyframes at most MAX_KEYFRAME_GAP_MS apart, so a receiver joining
 * mid-show shows the face within a second. Chrome's encoder only sends one
 * when asked (mediamtx asks every 2 s) and Chrome 157 has no generateKeyFrame,
 * so when none came in time the encoding is switched off and on: the encoder
 * restarts with a keyframe, at the cost of one held frame (~70 ms) per forced keyframe.
 */
function keepKeyFrames(sender: RTCRtpSender): () => void {
  let seen = -1;
  let lastKeyAt = performance.now();
  let forcing = false;
  const timer = window.setInterval(() => {
    if (forcing) return;
    void sender.getStats().then(async (report) => {
      let count = -1;
      report.forEach((stats: { type?: string; keyFramesEncoded?: number }) => {
        if (stats.type === 'outbound-rtp' && typeof stats.keyFramesEncoded === 'number') count = stats.keyFramesEncoded;
      });
      const now = performance.now();
      if (count !== seen) {
        seen = count;
        lastKeyAt = now;
        return;
      }
      if (now - lastKeyAt < MAX_KEYFRAME_GAP_MS) return;
      forcing = true;
      lastKeyAt = now;
      try {
        const off = sender.getParameters();
        off.encodings.forEach((encoding) => { encoding.active = false; });
        await sender.setParameters(off);
        const on = sender.getParameters();
        on.encodings.forEach((encoding) => { encoding.active = true; });
        await sender.setParameters(on);
      } finally {
        forcing = false;
      }
    }).catch(() => {});
  }, KEYFRAME_CHECK_MS);
  return () => window.clearInterval(timer);
}

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
  let stopKeyFrames: (() => void) | null = null;

  function status(next: PublisherStatus): void {
    options.onStatus(next);
  }

  function teardown(): void {
    window.clearTimeout(retryTimer);
    window.clearTimeout(dropTimer);
    stopKeyFrames?.();
    stopKeyFrames = null;
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
      const videoSender = next.pc.getSenders().find((sender) => sender.track?.kind === 'video');
      if (videoSender) stopKeyFrames = keepKeyFrames(videoSender);
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
    dispose() {
      disposed = true;
      generation += 1;
      teardown();
    },
  };
}
