import { describe, expect, it } from 'vitest';
import { createSentenceSplitter } from './sentence-splitter.js';

// The splitter sits between the streaming LLM and TTS. Each emitted chunk becomes
// one TTS request, so it decides how soon audio starts and where speech pauses.
function run(deltas: string[], options: { flush?: boolean } = {}): string[] {
  const out: string[] = [];
  const splitter = createSentenceSplitter((sentence) => out.push(sentence));
  for (const delta of deltas) {
    splitter.push(delta);
  }
  if (options.flush !== false) {
    splitter.flush();
  }
  return out;
}

describe('createSentenceSplitter', () => {
  it('emits each sentence as soon as it ends, even when deltas cut words apart', () => {
    const out: string[] = [];
    const splitter = createSentenceSplitter((sentence) => out.push(sentence));
    splitter.push('Hello the');
    expect(out).toEqual([]);
    splitter.push('re. How');
    // First sentence goes to TTS before the model has finished the reply.
    expect(out).toEqual(['Hello there.']);
    splitter.push(' are you?');
    expect(out).toEqual(['Hello there.', 'How are you?']);
  });

  it('keeps a decimal number together when it arrives in one delta', () => {
    expect(run(['Version 3.5 is out.'])).toEqual(['Version 3.5 is out.']);
  });

  // Known bug: a delta that ends right after a period is treated as a sentence end,
  // so TTS says "three." and then "five is out". Flip to `it` once fixed.
  it.fails('keeps a decimal number together when a delta ends at its period', () => {
    expect(run(['Version 3.', '5 is out.'])).toEqual(['Version 3.5 is out.']);
  });

  it('splits a long unpunctuated run at its last clause boundary so audio can start', () => {
    const chunks = run(
      ['I built this whole body from two plastic tubs, some ratchet straps, and a dream that never ends'],
      { flush: false },
    );
    expect(chunks).toEqual(['I built this whole body from two plastic tubs, some ratchet straps,']);
  });

  it('keeps an ordinary long sentence whole so the voice does not restart mid-phrase', () => {
    const sentence = 'Humanity spent thousands of years perfecting painting just to train algorithms to make fake pictures of women with six fingers.';
    expect(run([sentence])).toEqual([sentence]);
  });

  it('hard-splits runaway text at word boundaries past 200 characters', () => {
    const words = Array.from({ length: 80 }, (_value, index) => `word${index}`).join(' ');
    const chunks = run([words]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    // No word is cut in half and nothing is dropped.
    expect(chunks.join(' ')).toBe(words);
  });

  it('flush emits the unfinished tail and nothing when empty', () => {
    expect(run(['No punctuation at the end'])).toEqual(['No punctuation at the end']);
    expect(run([])).toEqual([]);
    expect(run(['   '])).toEqual([]);
  });
});
