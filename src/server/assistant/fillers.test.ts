import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stand-in for the Python TTS stream: every line comes back as one clip, or
// as several chunks when `chunks` is set (Ming streams a line in pieces).
const tts = vi.hoisted(() => ({ opened: true, opens: 0, sent: [] as string[], chunks: null as ((text: string) => string[]) | null }));
vi.mock('../tts/stream.js', () => ({
  openTtsStream: (options: { onChunk: (chunk: { text: string; audio: string; more?: boolean }) => void; onSentenceDone: () => void }) => (tts.opens += 1, {
    opened: Promise.resolve(tts.opened),
    send(text: string) {
      tts.sent.push(text);
      queueMicrotask(() => {
        const parts = tts.chunks?.(text) ?? [`wav:${text}`];
        parts.forEach((audio, i) => options.onChunk({ text, audio, ...(i < parts.length - 1 ? { more: true } : {}) }));
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

/** A 24 kHz mono 16-bit WAV with these samples, base64, as the TTS service sends it. */
function wav(values: number[]): string {
  const out = Buffer.alloc(44 + values.length * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + values.length * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24);
  out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(values.length * 2, 40);
  values.forEach((v, i) => out.writeInt16LE(v, 44 + i * 2));
  return out.toString('base64');
}

/** The samples of a WAV that has exactly the canonical 44-byte header (and checks its sizes). */
function samples(base64: string): number[] {
  const buf = Buffer.from(base64, 'base64');
  expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
  expect(buf.readUInt32LE(40)).toBe(buf.length - 44);
  return Array.from({ length: (buf.length - 44) / 2 }, (_, i) => buf.readInt16LE(44 + i * 2));
}

describe('fillers', () => {
  beforeEach(() => {
    tts.opened = true;
    tts.opens = 0;
    tts.sent = [];
    tts.chunks = null;
  });

  // A filler plays as one clip. When Ming streams "Um, okay." in two chunks,
  // keeping them as two fillers would play half the sound on some turns.
  it('keeps a line that arrives in several chunks as one whole clip', async () => {
    tts.chunks = () => [wav([1, 2]), wav([3]), wav([4, 5])];
    const { pickFiller, prepareFillers, FILLER_LINES } = await loadFresh();
    prepareFillers('ming:friend');
    await flush();
    const seen = new Map<string, string>();
    for (let k = 0; k < 60 && seen.size < FILLER_LINES.length; k += 1) {
      const rolls = [0, k / 60];
      const filler = pickFiller('ming:friend', () => rolls.shift() ?? 0);
      if (filler) seen.set(filler.text, filler.audio);
      pickFiller('ming:friend', () => 0);
    }
    expect(seen.size).toBe(FILLER_LINES.length);
    for (const audio of seen.values()) expect(samples(audio)).toEqual([1, 2, 3, 4, 5]);
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
