export type { VadModelId, VadProvider, VadResult } from './types.js';
export { createRmsVad } from './rms-vad.js';
export { createTenVad } from './ten-vad.js';

import type { VadModelId, VadProvider } from './types.js';
import { createRmsVad } from './rms-vad.js';
import { createTenVad } from './ten-vad.js';

export function createVadProvider(
  model: VadModelId,
  opts: { noiseGate: number; sampleRate: number },
): VadProvider {
  switch (model) {
    case 'ten-vad':
      return createTenVad(opts.sampleRate);
    case 'rms':
    default:
      return createRmsVad(opts.noiseGate);
  }
}
