import { describe, expect, it } from 'vitest';
import { isTalkingOverTubs } from './voice-runtime.js';

// An interrupt tells the server Tubs was cut off, and he reacts to it. It must
// only fire when someone actually talks over him.
describe('talking over Tubs', () => {
  it('counts while his voice is playing', () => {
    const speaking = { audioPlaying: true, currentSpeechText: 'Nice jacket.' };
    expect(isTalkingOverTubs(speaking)).toBe(true);
  });

  it('does not count once he has finished, even while his subtitle is still up', () => {
    const finished = { audioPlaying: false, currentSpeechText: 'Nice jacket.' };
    expect(isTalkingOverTubs(finished)).toBe(false);
  });
});
