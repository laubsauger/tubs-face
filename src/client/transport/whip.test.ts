import { describe, expect, it } from 'vitest';
import { PUBLISH_MIN_KBPS, PUBLISH_START_KBPS, h264Preferences, reconnectDelayMs, withStartBitrate } from './whip.js';

// What Chrome offers for video (trimmed from a real getCapabilities list).
const chromeVideoCodecs = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/AV1', clockRate: 90000 },
  { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
];

// The site node and every window renderer take faces as H.264
// (video-codec=h264/90000). Offered VP8 first, Chrome would send VP8 and the
// face would not play on the projector boxes.
describe('face video codec', () => {
  it('offers H.264 only', () => {
    const offered = h264Preferences(chromeVideoCodecs);
    expect(offered.length).toBe(3);
    expect(offered.every((codec) => codec.mimeType === 'video/H264' && codec.clockRate === 90000)).toBe(true);
  });

  it('puts constrained baseline in packetization mode 1 first: no B-frames, plays everywhere', () => {
    expect(h264Preferences(chromeVideoCodecs)[0]?.sdpFmtpLine).toContain('profile-level-id=42e01f');
    expect(h264Preferences(chromeVideoCodecs)[0]?.sdpFmtpLine).toContain('packetization-mode=1');
  });

  it('finds nothing when the browser has no H.264, so the page says so instead of sending VP8', () => {
    expect(h264Preferences(chromeVideoCodecs.filter((codec) => codec.mimeType !== 'video/H264'))).toEqual([]);
  });
});

// A site node that restarts mid-show must get the faces back by itself, fast
// at first, and without hammering it while it is down.
describe('reconnect delay', () => {
  it('starts quick, backs off, and settles at 10 s', () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(3)).toBe(4000);
    expect(reconnectDelayMs(10)).toBe(10_000);
    expect(reconnectDelayMs(1000)).toBe(10_000);
  });
});

// A new publish used to lose frames for its first seconds while Chrome ramped
// the bitrate up from a few hundred kbit/s (gaps of 70 ms and more in the
// stream); the answer tells it to start where a LAN can take it.
describe('the start bitrate of a face stream', () => {
  const answer = [
    'v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 102 96', 'a=rtpmap:102 H264/90000',
    'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', 'a=rtpmap:96 VP8/90000', 'a=fmtp:96 x=1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', '',
  ].join('\r\n');

  it('starts and stays high enough for 1024x1024 at 30 fps, on H.264 only', () => {
    const shaped = withStartBitrate(answer);
    expect(shaped).toContain(`profile-level-id=42e01f;x-google-start-bitrate=${PUBLISH_START_KBPS};x-google-min-bitrate=${PUBLISH_MIN_KBPS}\r\n`);
    expect(shaped).toContain('a=fmtp:96 x=1\r\n');
    expect(shaped).toContain('a=fmtp:111 minptime=10;useinbandfec=1\r\n');
    expect(PUBLISH_START_KBPS).toBeGreaterThanOrEqual(2000);
    expect(withStartBitrate(shaped)).toBe(shaped);
  });
});
