import { describe, expect, it } from 'vitest';
import { sanitizeForTts, unwrapJsonSpeechText } from './text.js';

describe('unwrapJsonSpeechText', () => {
  it('extracts main text from a JSON envelope', () => {
    expect(unwrapJsonSpeechText('{ "main": "I have calculated the exact probability." }')).toBe(
      'I have calculated the exact probability.',
    );
  });

  it('keeps plain text unchanged', () => {
    expect(unwrapJsonSpeechText('Normal sentence.')).toBe('Normal sentence.');
  });
});

describe('sanitizeForTts', () => {
  // History and stage directions use bracketed notes; if the model echoes one
  // it must not be read aloud.
  it('drops bracketed notes instead of speaking them', () => {
    expect(sanitizeForTts('Rude. [cut off by the visitor] Anyway, hi.')).toBe('Rude. Anyway, hi.');
  });

  it('removes structural JSON characters after unwrapping', () => {
    expect(sanitizeForTts(unwrapJsonSpeechText('😏 { "main": "Donate a nickel." }'))).toBe('Donate a nickel.');
  });
});
