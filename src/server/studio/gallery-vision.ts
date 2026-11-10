// The gallery night with vision on: the heads take their own look at the pictures (sentient-studio
// contract §6, studio_context.gallery and .tour). The archive's words come with every picture; with a
// vision provider in use and descriptions switched on, the pictures where the heads stand and the one
// pulled up on the tour are also described by it, once each, and what it saw goes into the prompt next
// to what the archive says. With vision off nothing leaves the server: the archive's words carry it.

import { runtimeConfig } from '../config/runtime.js';

export interface GalleryPicture {
  title: string;
  date?: string;
  /** where the picture is served (the director's /gallery/ folder) */
  img?: string;
}

export interface GalleryVisionDeps {
  describe(dataUrl: string, ask: { system: string; prompt: string; maxTokens: number }): Promise<string | null>;
  fetch: typeof fetch;
  now(): number;
}

/** at most this many pictures are described an hour (each once; the night goes through a few dozen) */
export const GALLERY_LOOKS_PER_HOUR = 60;
/** a picture this large (bytes) is not sent */
const MAX_BYTES = 8 * 1024 * 1024;

export const GALLERY_VISION_SYSTEM = 'You describe archival pictures for a gallery guide.';

export function galleryVisionPrompt(p: GalleryPicture): string {
  return `This picture is "${p.title}"${p.date ? `, ${p.date}` : ''}, from the Alan Watts archive. In two or three plain sentences say what is visible: the people or things, the setting, and one or two details a guide could point at. Do not name anyone the title does not name and do not guess dates. Under 70 words.`;
}

const seen = new Map<string, { state: 'looking' | 'done' | 'failed'; text: string | null }>();
const looks: number[] = [];
const queue: GalleryPicture[] = [];
let running = false;

/** What the heads saw in a picture themselves, once they have looked; null before or without vision. */
export function seenInPicture(img: string | undefined): string | null {
  return img ? seen.get(img)?.text ?? null : null;
}

/** vision in use: a provider set and descriptions switched on */
export function galleryVisionOn(): boolean {
  return runtimeConfig.visionProvider !== 'off' && runtimeConfig.visionDescriptions;
}

/** Look at these pictures (once each), one after another, while vision is on. */
export function lookAtGalleryPictures(pictures: GalleryPicture[], deps: GalleryVisionDeps): void {
  if (!galleryVisionOn()) return;
  for (const p of pictures) {
    if (!p.img || seen.has(p.img) || queue.some((q) => q.img === p.img)) continue;
    queue.push(p);
  }
  void pump(deps);
}

async function pump(deps: GalleryVisionDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length && galleryVisionOn()) {
      const hourAgo = deps.now() - 3_600_000;
      while (looks.length && looks[0]! < hourAgo) looks.shift();
      if (looks.length >= GALLERY_LOOKS_PER_HOUR) break;
      const p = queue.shift()!;
      seen.set(p.img!, { state: 'looking', text: null });
      looks.push(deps.now());
      const text = await look(p, deps).catch(() => null);
      seen.set(p.img!, { state: text ? 'done' : 'failed', text });
    }
  } finally {
    running = false;
  }
}

async function look(p: GalleryPicture, deps: GalleryVisionDeps): Promise<string | null> {
  const res = await deps.fetch(p.img!, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) return null;
  return deps.describe(`data:${type};base64,${bytes.toString('base64')}`, { system: GALLERY_VISION_SYSTEM, prompt: galleryVisionPrompt(p), maxTokens: 140 });
}

/** Tests: forget what was seen. */
export function resetGalleryVision(): void {
  seen.clear();
  looks.length = 0;
  queue.length = 0;
}
