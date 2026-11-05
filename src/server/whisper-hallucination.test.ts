import { describe, expect, it } from 'vitest';
import { isWhisperHallucination } from './whisper-hallucination.js';

// Fed noise, Whisper loops a phrase. Tubs answered "I'm sorry." x29 as if a
// visitor had said it; a dropped transcript costs nothing, a phantom turn does.
describe('Whisper hallucinations', () => {
  it('drops the looping transcripts heard live', () => {
    expect(isWhisperHallucination(Array(29).fill("I'm sorry.").join(' '))).toBe(true);
    expect(isWhisperHallucination(Array(7).fill("I'm going to go back to the room.").join(' '))).toBe(true);
  });

  it('keeps what visitors actually say, repeats included', () => {
    expect(isWhisperHallucination("Me also, Tabs, what's your take on the midterm elections? I guess the Republicans got kind of massacred.")).toBe(false);
    expect(isWhisperHallucination('So I was thinking about getting a dog, but my landlord says no pets, and honestly I travel too much anyway.')).toBe(false);
    expect(isWhisperHallucination('No, no, no, no!')).toBe(false);
  });
});
