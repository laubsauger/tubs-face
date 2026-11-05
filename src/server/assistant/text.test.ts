import { describe, expect, it } from 'vitest';
import { BIT_MAX_SENTENCES, clampOutput, createSentenceCap, sanitizeForTts, unwrapJsonSpeechText } from './text.js';

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
  // Heard live: Mini's "WHO SAID THAT? WITNESS PROTECTION NOW!" came out
  // garbled, since the voice chokes on words in capitals.
  it('turns shouted capitals into words the voice can say, keeping acronyms', () => {
    expect(sanitizeForTts('😏 WHO SAID THAT? WITNESS PROTECTION NOW!')).toBe('Who said that? Witness protection now!');
    expect(sanitizeForTts("Fine, I'M NOT YELLING. The AI on TV is.")).toBe("Fine, I'm not yelling. The AI on TV is.");
  });

  // Ming reads digits badly ("204" came out as "24").
  it('says numbers as words, years the way people say them', () => {
    expect(sanitizeForTts('ELECTROMAGNETIC PULSE 2024!')).toBe('Electromagnetic pulse twenty twenty-four!');
    expect(sanitizeForTts('Since 1905, 87 people and 2005 bugs.')).toBe('Since nineteen oh-five, eighty-seven people and two thousand five bugs.');
    expect(sanitizeForTts('At 10:30 with 87.4 percent of 1,000 fans.')).toBe('At 10:30 with 87.4 percent of 1,000 fans.');
  });

  // History and stage directions use bracketed notes; if the model echoes one
  // it must not be read aloud.
  it('drops bracketed notes instead of speaking them', () => {
    expect(sanitizeForTts('Rude. [cut off by the visitor] Anyway, hi.')).toBe('Rude. Anyway, hi.');
  });

  it('removes structural JSON characters after unwrapping', () => {
    expect(sanitizeForTts(unwrapJsonSpeechText('😏 { "main": "Donate a nickel." }'))).toBe('Donate a nickel.');
  });
});

// Streamed replies arrive in clause chunks. Counting chunks as sentences made
// two-sentence replies stop on a comma.
describe('createSentenceCap', () => {
  it('lets clause chunks through until two whole sentences were spoken', () => {
    const admit = createSentenceCap(2);
    const chunks = ['I cannot drink it, but judging by the dread in this room,', 'it is terrible.', 'Ask the barista.', 'Third sentence.'];
    expect(chunks.map(admit)).toEqual([true, true, true, false]);
  });
});

// A bit lands on its last line. The default two-sentence clamp would cut the
// punchline off; a normal reply must still be held to two.
describe('clampOutput with a bit budget', () => {
  const BIT = 'Let me tell you something about this studio. People come in and ask if I am alive. I say, define alive. Then they ask if I can dance. I cannot dance. I have standards.';
  it('keeps the whole bit, punchline included', () => {
    expect(clampOutput(BIT, BIT_MAX_SENTENCES)).toBe(BIT);
  });
  it('still holds a normal reply to two sentences', () => {
    expect(clampOutput(BIT)).toBe('Let me tell you something about this studio. People come in and ask if I am alive.');
  });
});

// The studio is "two-oh-four". Voices read "204" as "two hundred four" or
// mangle it ("24", "2014"), so it is spelled out before speech.
describe('Studio 204', () => {
  it('is spoken as two-oh-four', () => {
    expect(sanitizeForTts('Welcome to Studio 204.')).toBe('Welcome to Studio two-oh-four.');
    // Only the studio's number; 2048 is its own number, said as one.
    expect(sanitizeForTts('Room 2048 is elsewhere.')).toBe('Room twenty forty-eight is elsewhere.');
  });
});

