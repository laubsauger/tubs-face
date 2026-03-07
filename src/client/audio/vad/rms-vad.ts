import type { VadProvider, VadResult } from './types.js';

/**
 * Original RMS-based "VAD". Computes root-mean-square amplitude and
 * applies a simple noise-gate threshold. Not a real model, but the
 * existing baseline behaviour.
 */
export function createRmsVad(noiseGate: number): VadProvider {
  const gate = Math.max(0.008, noiseGate);
  const threshold = Math.max(0.018, gate * 2.5);

  return {
    id: 'rms',
    async init() {
      // nothing to load
    },
    process(samples: Float32Array): VadResult {
      let sum = 0;
      for (const s of samples) {
        sum += s * s;
      }
      const rms = Math.sqrt(sum / samples.length);
      return {
        isVoice: rms >= threshold,
        probability: Math.min(1, rms / threshold),
      };
    },
    dispose() {
      // nothing to release
    },
  };
}
