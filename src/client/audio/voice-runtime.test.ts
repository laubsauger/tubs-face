import { describe, expect, it } from 'vitest';
import { isTalkingOverTubs, liveTranscriptFrom } from './voice-runtime.js';

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

// Chrome keeps every result of a recognition session and lists them all again
// on each event. Built from index 0, the live caption held the whole night:
// the visitor's earlier lines and Tubs' own voice from the speakers.
describe('live caption', () => {
  const result = (transcript: string, isFinal = true) => ({ isFinal, length: 1, 0: { transcript } });
  const session = [result('Hey Tubs.'), result(' Serve the pink crested primate.'), result(' What do you mean', false)];

  it('shows only what came after the last handled point', () => {
    expect(liveTranscriptFrom(session, 2)).toEqual({ text: 'What do you mean', interim: true });
  });

  it('shows the whole session when nothing was handled yet', () => {
    expect(liveTranscriptFrom(session.slice(0, 2), 0)).toEqual({ text: 'Hey Tubs. Serve the pink crested primate.', interim: false });
  });
});
