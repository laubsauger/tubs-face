export interface TranscriptionResult {
  text: string;
  language?: string;
  probability?: number;
}

export interface TtsProxyTarget {
  hostname: string;
  port: number;
  path: string;
}

export interface ProcessingModeAdapter {
  readonly id: 'legacy' | 'realtime';
  startProcessingStack(options?: { sttModel?: string }): void | Promise<void>;
  stopProcessingStack(timeoutMs?: number): Promise<boolean>;
  restartTranscriptionService(modelName: string, reason?: string): Promise<void>;
  transcribeAudio(audioBuffer: Buffer, mimeType?: string): Promise<TranscriptionResult>;
  getTtsProxyTarget(): TtsProxyTarget;
}
