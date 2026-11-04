import { describe, expect, it } from 'vitest';
import { subtitleSeconds } from './speech-runtime.js';

// A reply Ming streams in chunks gets one subtitle, started with its first
// chunk, before anyone knows how long the reply will be.
describe('subtitleSeconds', () => {
  const reply = 'Two million followers. That is impressive. You must be very lonely.'; // 11 words

  it('sizes a reply still arriving by its words, so the highlight does not race through it in the first chunk', () => {
    expect(subtitleSeconds({ text: reply, duration: 0.5, open: true })).toBeCloseTo(11 * 0.3);
  });

  // Ran out, the highlight would sit on the last word (or finish) while audio
  // already on its way still has words in it.
  it('always runs past the audio already scheduled while more is coming', () => {
    expect(subtitleSeconds({ text: reply, duration: 4, open: true })).toBeGreaterThan(4);
  });

  it('runs exactly as long as the audio once the last chunk is in', () => {
    expect(subtitleSeconds({ text: reply, duration: 2.7, open: false })).toBe(2.7);
    expect(subtitleSeconds({ text: 'Nice hat.', duration: 0.8, open: false })).toBe(0.8);
  });
});
