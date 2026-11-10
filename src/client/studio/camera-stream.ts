// The studio camera as live video in the dashboard, when it is a site node
// stream (visionSource site:<path>): the dashboard reads it over WHEP itself
// instead of waiting for the listener's relayed pictures (one every couple of
// seconds for a site source). One session for every view that shows it,
// closed a moment after the last one goes.

import { whepVideo, type WhepVideo } from '../transport/whip.js';
import { parseVisionSource } from '../../shared/contracts/studio.js';

const CLOSE_AFTER_MS = 1500;

let shared: { url: string; users: number; video: Promise<WhepVideo>; closeTimer: number } | null = null;

/** The WHEP URL a dashboard reads the studio camera from; null unless the vision source is a site stream. */
export function studioCameraUrl(config: { enabled: boolean; site: string; visionSource: string }, pageHost: string): string | null {
  if (!config.enabled) return null;
  const source = parseVisionSource(config.visionSource);
  if (source?.kind !== 'site') return null;
  try {
    const site = new URL(config.site);
    // The site node on the studio Mac's loopback: from another machine, the same host the dashboard came from.
    const loopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
    if (loopback(site.hostname) && pageHost && !loopback(pageHost)) site.hostname = pageHost;
    return `${site.toString().replace(/\/+$/, '')}/${source.path}/whep`;
  } catch {
    return null;
  }
}

export function acquireStudioCamera(url: string): { stream: Promise<MediaStream>; release(): void } {
  if (shared && shared.url !== url) {
    const old = shared;
    shared = null;
    void old.video.then((video) => video.close()).catch(() => {});
  }
  if (!shared) shared = { url, users: 0, video: whepVideo(url), closeTimer: 0 };
  const entry = shared;
  window.clearTimeout(entry.closeTimer);
  entry.users += 1;
  // A failed session is forgotten, so the next view tries again.
  entry.video.catch(() => {
    if (shared === entry) shared = null;
  });
  let released = false;
  return {
    stream: entry.video.then((video) => video.stream),
    release() {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entry.users > 0) return;
      entry.closeTimer = window.setTimeout(() => {
        if (shared === entry && entry.users === 0) shared = null;
        void entry.video.then((video) => video.close()).catch(() => {});
      }, CLOSE_AFTER_MS);
    },
  };
}
