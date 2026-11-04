import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stand-in for the Python TTS stream: every line comes back as one clip.
const tts = vi.hoisted(() => ({ opened: true, opens: 0, sent: [] as string[] }));
vi.mock('../tts/stream.js', () => ({
  openTtsStream: (options: { onChunk: (chunk: { text: string; audio: string }) => void; onSentenceDone: () => void }) => (tts.opens += 1, {
    opened: Promise.resolve(tts.opened),
    send(text: string) {
      tts.sent.push(text);
      queueMicrotask(() => {
        options.onChunk({ text, audio: `wav:${text}` });
        options.onSentenceDone();
      });
    },
    close() {},
  }),
}));

async function loadFresh() {
  vi.resetModules();
  return import('./fillers.js');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('fillers', () => {
  beforeEach(() => {
    tts.opened = true;
    tts.opens = 0;
    tts.sent = [];
  });

  it('renders the clips on first use instead of stalling that turn', async () => {
    const { pickFiller, FILLER_LINES } = await loadFresh();
    expect(pickFiller('af_heart', () => 0)).toBeNull();
    await flush();
    expect(tts.sent).toEqual([...FILLER_LINES]);
    expect(pickFiller('af_heart', () => 0)?.audio).toBe('wav:Oh.');
  });

  // A filler on every turn becomes a tic people notice within a minute.
  it('never plays twice in a row and skips most turns', async () => {
    const { pickFiller, prepareFillers, FILLER_CHANCE } = await loadFresh();
    prepareFillers('af_heart');
    await flush();
    expect(pickFiller('af_heart', () => 0)).not.toBeNull();
    expect(pickFiller('af_heart', () => 0)).toBeNull();
    expect(pickFiller('af_heart', () => FILLER_CHANCE + 0.01)).toBeNull();
    expect(pickFiller('af_heart', () => 0)).not.toBeNull();
  });

  it('does not repeat the same sound back to back', async () => {
    const { pickFiller, prepareFillers } = await loadFresh();
    prepareFillers('af_heart');
    await flush();
    const first = pickFiller('af_heart', () => 0)?.text;
    pickFiller('af_heart', () => 0.99); // skipped turn
    expect(pickFiller('af_heart', () => 0)?.text).not.toBe(first);
  });

  // The filler's text is shown as the subtitle. Kokoro needs phoneme markup
  // for "Ähm", but visitors must read the word, never "[Ähm](/ˈɛːm/)".
  it('subtitles show the plain words, not the phoneme markup sent to Kokoro', async () => {
    const { pickFiller, prepareFillers, FILLER_LINES } = await loadFresh();
    prepareFillers('af_heart');
    await flush();
    expect(tts.sent.some((line) => line.includes('/'))).toBe(true);
    const shown = new Set<string>();
    for (let k = 0; k < 50; k += 1) {
      const rolls = [0, k / 50];
      const filler = pickFiller('af_heart', () => rolls.shift() ?? 0);
      if (filler) shown.add(filler.text);
      pickFiller('af_heart', () => 0); // the turn after a filler goes without
    }
    expect(shown.size).toBe(FILLER_LINES.length);
    expect([...shown]).toContain('Ähm, okay.');
    for (const text of shown) expect(text).not.toMatch(/[[\]()/]/);
  });

  it('goes without fillers when the TTS is down, and does not retry every turn', async () => {
    tts.opened = false;
    const { pickFiller } = await loadFresh();
    expect(pickFiller('af_heart', () => 0)).toBeNull();
    await flush();
    expect(pickFiller('af_heart', () => 0)).toBeNull();
    expect(tts.opens).toBe(1);
  });
});
