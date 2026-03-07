export type VadModelId = 'rms' | 'ten-vad';

export interface VadResult {
  /** Whether voice activity was detected this frame. */
  isVoice: boolean;
  /** Confidence / probability in [0, 1]. For RMS this is a normalised amplitude. */
  probability: number;
}

export interface VadProvider {
  readonly id: VadModelId;
  /** Resolves once the model is loaded and ready. */
  init(): Promise<void>;
  /** Feed a chunk of float32 PCM samples (any length). Returns the latest result. */
  process(samples: Float32Array): VadResult;
  dispose(): void;
}
