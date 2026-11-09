// WHIP (publish) and WHEP (play) against the studio site node (mediamtx).
// Media never goes through the Tubs server: pages talk to the site node directly.

const ICE_GATHER_TIMEOUT_MS = 2000;

/** Retry delay after the attempt-th failure in a row: 0.5 s, 1, 2, 4, 8, then every 10 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, attempt));
}

interface CodecLike {
  mimeType: string;
  clockRate: number;
  sdpFmtpLine?: string;
}

/**
 * The codec list for a face's video: H.264 at 90 kHz only (the contract pins
 * video-codec=h264/90000), so the site node never gets VP8 or AV1. Constrained
 * baseline in packetization mode 1 first: no B-frames, and every receiver
 * (browsers, hardware decoders, projector boxes) plays it.
 */
export function h264Preferences<T extends CodecLike>(codecs: readonly T[]): T[] {
  const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264' && codec.clockRate === 90_000);
  const score = (codec: T) => {
    const fmtp = codec.sdpFmtpLine ?? '';
    return (/packetization-mode=1/.test(fmtp) ? 2 : 0) + (/profile-level-id=42e0/i.test(fmtp) ? 1 : 0);
  };
  return [...h264].sort((a, b) => score(b) - score(a));
}

/**
 * Chrome starts a new video send at a few hundred kbit/s and ramps up; at
 * 1024x1024 the encoder drops frames meanwhile (gaps of 70 ms and more for the
 * first seconds of every publish). On the studio LAN it can start high.
 */
export const PUBLISH_START_KBPS = 4000;
export const PUBLISH_MIN_KBPS = 2000;

/** The answer with Chrome's start and minimum bitrate added to each H.264 fmtp line. */
export function withStartBitrate(sdp: string, startKbps = PUBLISH_START_KBPS, minKbps = PUBLISH_MIN_KBPS): string {
  const h264 = new Set<string>();
  for (const match of sdp.matchAll(/^a=rtpmap:(\d+) H264\/90000/gim)) h264.add(match[1]!);
  return sdp.replace(/^(a=fmtp:(\d+) [^\r\n]*)$/gm, (line: string, _all: string, payload: string) =>
    h264.has(payload) && !line.includes('x-google-start-bitrate') ? `${line};x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps}` : line);
}

export interface WhipSession {
  pc: RTCPeerConnection;
  /** The session resource (Location); DELETE ends it. */
  resource: string | null;
}

/** Offers `pc`'s transceivers to a WHIP/WHEP endpoint and applies the answer. */
async function negotiate(pc: RTCPeerConnection, url: string, shapeAnswer: (sdp: string) => string = (sdp) => sdp): Promise<string | null> {
  await pc.setLocalDescription(await pc.createOffer());
  await iceGathered(pc);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription?.sdp ?? '',
  });
  if (response.status !== 201 && response.status !== 200) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
    throw new Error(`${url} answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const answer = await response.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: shapeAnswer(answer) });
  const location = response.headers.get('Location');
  return location ? new URL(location, url).toString() : null;
}

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    // Host candidates are enough on the studio LAN; don't wait on slow STUN.
    const timer = window.setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/** Ends a session on the site node; best effort (it times the session out anyway). */
export function endSession(resource: string | null): void {
  if (!resource) return;
  void fetch(resource, { method: 'DELETE' }).catch(() => {});
}

/** Publishes the video and audio track of `stream` in one session, so lip sync holds. */
export async function whipPublish(url: string, stream: MediaStream, options: { maxBitrate: number; maxFramerate: number }): Promise<WhipSession> {
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  try {
    for (const track of stream.getVideoTracks()) {
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [{ maxBitrate: options.maxBitrate, maxFramerate: options.maxFramerate }],
      });
      const capabilities = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
      const h264 = h264Preferences(capabilities);
      if (h264.length === 0) throw new Error('this browser cannot send H.264');
      transceiver.setCodecPreferences(h264);
      // A pixel face blurred to half size is worse than a dropped frame.
      const parameters = transceiver.sender.getParameters();
      await transceiver.sender.setParameters({ ...parameters, degradationPreference: 'maintain-resolution' }).catch(() => {});
    }
    for (const track of stream.getAudioTracks()) {
      pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    }
    const resource = await negotiate(pc, url, withStartBitrate);
    return { pc, resource };
  } catch (error) {
    pc.close();
    throw error;
  }
}

export interface WhepAudio {
  stream: MediaStream;
  close(): void;
}

/**
 * The audio of a site node stream (WHEP, receive only). Chrome sends remote
 * WebRTC audio into Web Audio only while the stream also plays in a media
 * element, so it plays in a muted one; without it the mic would hear silence.
 * `onEnded` fires once if the session fails or drops.
 */
export async function whepAudio(url: string, onEnded: (reason: string) => void): Promise<WhepAudio> {
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  const element = new Audio();
  element.muted = true;
  element.autoplay = true;
  let resource: string | null = null;
  let ended = false;
  let dropTimer = 0;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    close();
    onEnded(reason);
  };
  const close = () => {
    ended = true;
    window.clearTimeout(dropTimer);
    pc.onconnectionstatechange = null;
    element.srcObject = null;
    for (const track of stream.getTracks()) track.stop();
    pc.close();
    endSession(resource);
    resource = null;
  };
  try {
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const gotTrack = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`no audio from ${url}`)), 8000);
      pc.ontrack = (event) => {
        if (event.track.kind !== 'audio') return;
        stream.addTrack(event.track);
        window.clearTimeout(timer);
        resolve();
      };
    });
    resource = await negotiate(pc, url);
    await gotTrack;
    element.srcObject = stream;
    void element.play().catch(() => {});
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        end(`site mic ${state}`);
      } else if (state === 'disconnected') {
        // Often comes back by itself; give it a moment.
        window.clearTimeout(dropTimer);
        dropTimer = window.setTimeout(() => {
          if (pc.connectionState !== 'connected') end('site mic disconnected');
        }, 4000);
      }
    };
    return { stream, close };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * One picture from a site node stream (WHEP, video, receive only): open, wait
 * for the first frame, close again. Nothing streams between pictures.
 */
export async function whepPicture(url: string, timeoutMs = 8000): Promise<ImageBitmap> {
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  let resource: string | null = null;
  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    const gotTrack = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`no video from ${url}`)), timeoutMs);
      pc.ontrack = (event) => {
        if (event.track.kind !== 'video') return;
        stream.addTrack(event.track);
        window.clearTimeout(timer);
        resolve();
      };
    });
    resource = await negotiate(pc, url);
    await gotTrack;
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`no frame from ${url}`)), timeoutMs);
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      if (video.readyState >= 2 && video.videoWidth > 0) done();
      else video.addEventListener('loadeddata', done, { once: true });
    });
    return await createImageBitmap(video);
  } finally {
    video.srcObject = null;
    for (const track of stream.getTracks()) track.stop();
    pc.close();
    endSession(resource);
  }
}
