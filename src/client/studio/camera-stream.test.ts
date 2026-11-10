import { describe, expect, it } from 'vitest';
import { studioCameraUrl } from './camera-stream.js';

// A dashboard reads a site-stream studio camera itself, live. The site node
// is often given as the studio Mac's loopback; a dashboard on another machine
// must ask the studio Mac, not itself.

const config = { enabled: true, site: 'http://127.0.0.1:8889', visionSource: 'site:cam-flo-mac' };

describe('studioCameraUrl', () => {
  it('is the site stream\'s WHEP URL, on the host the dashboard came from when the site is a loopback address', () => {
    expect(studioCameraUrl(config, '127.0.0.1')).toBe('http://127.0.0.1:8889/cam-flo-mac/whep');
    expect(studioCameraUrl(config, 'studio-mac.local')).toBe('http://studio-mac.local:8889/cam-flo-mac/whep');
    expect(studioCameraUrl({ ...config, site: 'http://site-node:8889' }, 'studio-mac.local')).toBe('http://site-node:8889/cam-flo-mac/whep');
  });

  it('is nothing for a camera only the listener can reach, or with studio mode off', () => {
    expect(studioCameraUrl({ ...config, visionSource: 'local' }, 'studio-mac.local')).toBeNull();
    expect(studioCameraUrl({ ...config, visionSource: 'snapshot:http://cam/api/snapshot/color.jpg' }, 'studio-mac.local')).toBeNull();
    expect(studioCameraUrl({ ...config, enabled: false }, 'studio-mac.local')).toBeNull();
  });
});
