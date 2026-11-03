import { describe, expect, it } from 'vitest';
import { createClipBuffer, encodeWav16k } from './pcm-clip.js';

const RATE = 1000; // 1 sample per ms keeps the arithmetic readable

function chunk(from: number, length = 100): Float32Array {
  return Float32Array.from({ length }, (_value, i) => (from + i) / 10_000);
}

// Recording starts only once speech is detected, a few hundred ms after it
// began. The clip has to include that lead-in or the first word is lost.
describe('createClipBuffer', () => {
  it('starts a clip with the last pre-roll of audio heard before begin()', () => {
    const buffer = createClipBuffer(RATE, 300, 10_000);
    for (let t = 0; t < 1000; t += 100) buffer.push(chunk(t)); // 1 s of "room"
    buffer.begin();
    buffer.push(chunk(1000)); // speech continues
    const samples = buffer.end();

    expect(samples.length).toBe(400);
    // First sample is from 700 ms in: exactly 300 ms before begin().
    expect(samples[0]).toBeCloseTo(700 / 10_000);
    expect(samples.at(-1)).toBeCloseTo(1099 / 10_000);
  });

  it('can skip the pre-roll, e.g. right after Tubs was talking', () => {
    const buffer = createClipBuffer(RATE, 300, 10_000);
    buffer.push(chunk(0));
    buffer.begin({ preRoll: false });
    buffer.push(chunk(100));
    expect(buffer.end()[0]).toBeCloseTo(100 / 10_000);
  });

  it('caps a clip at the maximum length', () => {
    const buffer = createClipBuffer(RATE, 0, 250);
    buffer.begin();
    for (let t = 0; t < 1000; t += 100) buffer.push(chunk(t));
    expect(buffer.end().length).toBe(300);
  });

  it('returns nothing when no clip was started', () => {
    const buffer = createClipBuffer(RATE, 300, 10_000);
    buffer.push(chunk(0));
    expect(buffer.end().length).toBe(0);
    expect(buffer.capturing).toBe(false);
  });
});

describe('encodeWav16k', () => {
  it('writes a 16 kHz mono 16-bit WAV of the right length', () => {
    const oneSecondAt48k = new Float32Array(48_000).fill(0.5);
    const wav = encodeWav16k(oneSecondAt48k, 48_000);
    const view = new DataView(wav);
    const tag = (offset: number) => String.fromCharCode(...new Uint8Array(wav, offset, 4));

    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(16_000 * 2); // one second of samples
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 32767));
  });
});
