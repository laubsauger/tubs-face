import { afterEach, describe, expect, it } from 'vitest';
import { runtimeConfig } from '../config/runtime.js';
import { forgetStudioContext, noteStudioContext, studioContextLines } from './context.js';
import { lookAtGalleryPictures, resetGalleryVision, seenInPicture } from './gallery-vision.js';

const webp = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } });
const wait = () => new Promise((r) => setTimeout(r, 10));

// Asked for: on the gallery night the archive's words carry it; with vision switched on the heads also
// take their own look at the pictures, said properly in the prompt, and never at any cost: once each.
describe('gallery vision', () => {
  const was = { provider: runtimeConfig.visionProvider, descriptions: runtimeConfig.visionDescriptions };
  afterEach(() => {
    runtimeConfig.visionProvider = was.provider;
    runtimeConfig.visionDescriptions = was.descriptions;
    resetGalleryVision();
    forgetStudioContext();
  });

  it('with vision off nothing is sent: the archive carries it', async () => {
    runtimeConfig.visionProvider = 'off';
    const asks: string[] = [];
    lookAtGalleryPictures([{ title: 'Kimono', img: 'http://gallery/a.webp' }], { describe: async (d) => { asks.push(d); return 'x'; }, fetch: async () => webp(), now: Date.now });
    await wait();
    expect(asks).toEqual([]);
    expect(seenInPicture('http://gallery/a.webp')).toBeNull();
  });

  it('with vision on each picture is looked at once, and what was seen goes into the prompt beside the archive', async () => {
    runtimeConfig.visionProvider = 'gemini';
    runtimeConfig.visionDescriptions = true;
    const prompts: string[] = [];
    const deps = { describe: async (_d: string, ask: { prompt: string }) => { prompts.push(ask.prompt); return 'A man in a dark kimono, arms folded, before a plank wall.'; }, fetch: async () => webp(), now: Date.now };
    lookAtGalleryPictures([{ title: 'Watts in a kimono', date: '1966', img: 'http://gallery/k.webp' }], deps);
    lookAtGalleryPictures([{ title: 'Watts in a kimono', date: '1966', img: 'http://gallery/k.webp' }], deps);
    await wait();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"Watts in a kimono", 1966');
    expect(prompts[0]).toContain('Do not name anyone the title does not name');
    const now = Date.now();
    noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: now, gallery: { showing: [{ where: 'Book', here: true, pictures: [{ title: 'Watts in a kimono', date: '1966', text: 'Studio portrait.', img: 'http://gallery/k.webp' }] }] } }, now);
    const text = studioContextLines(now).join('\n');
    expect(text).toContain('Studio portrait.');
    expect(text).toContain('what you see in it yourself: A man in a dark kimono');
  });
});
