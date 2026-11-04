import { describe, expect, it } from 'vitest';
import { readSpeechLevel, speechOutput } from './speech-level.js';

// Lip sync: the mouth follows how loud the voice is, closing in pauses.

class FakeNode { connect() {} }
class FakeAnalyser extends FakeNode {
  fftSize = 512;
  amplitude = 0;
  getFloatTimeDomainData(target: Float32Array) {
    for (let i = 0; i < target.length; i += 1) target[i] = i % 2 === 0 ? this.amplitude : -this.amplitude;
  }
}
class FakeContext {
  destination = new FakeNode();
  analyser = new FakeAnalyser();
  createGain() { return new FakeNode(); }
  createAnalyser() { return this.analyser; }
}

describe('speech level', () => {
  it('opens on loud speech and closes again in a pause', () => {
    const context = new FakeContext();
    speechOutput(context as unknown as AudioContext);
    let now = 0;
    const settle = () => {
      let level = 0;
      for (let i = 0; i < 30; i += 1) level = readSpeechLevel((now += 16))!;
      return level;
    };

    context.analyser.amplitude = 0.15; // a loud syllable
    const loud = settle();
    context.analyser.amplitude = 0.02; // a breath between words
    const pause = settle();

    expect(loud).toBeGreaterThan(0.6);
    expect(pause).toBeLessThan(0.15);
  });
});
