import { describe, expect, it } from 'vitest';
import { h264Preferences, reconnectDelayMs } from './whip.js';

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
