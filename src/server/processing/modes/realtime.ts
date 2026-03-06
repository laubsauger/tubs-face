import { createPythonServiceController, buildRealtimeServiceEnv } from '../process-service.js';
import type { ProcessingModeAdapter } from '../types.js';

const REALTIME_PROCESSING_PORT = Number.parseInt(process.env.REALTIME_PROCESSING_PORT || '3002', 10) || 3002;

const service = createPythonServiceController({
  scriptName: 'realtime-processing-service.py',
  port: REALTIME_PROCESSING_PORT,
  envFactory: () => buildRealtimeServiceEnv(),
  logPrefix: '[realtime-python]',
});

export const realtimeProcessingMode: ProcessingModeAdapter = {
  id: 'realtime',
  startProcessingStack({ sttModel } = {}) {
    if (sttModel) {
      void service.restart();
      return;
    }
    service.start();
  },
  stopProcessingStack(timeoutMs = 5000) {
    return service.stop(timeoutMs);
  },
  async restartTranscriptionService() {
    await service.restart();
  },
  transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
    return service.postAudioMultipart('/transcribe', audioBuffer, mimeType) as Promise<{ text: string; language?: string; probability?: number }>;
  },
  getTtsProxyTarget() {
    return { hostname: '127.0.0.1', port: REALTIME_PROCESSING_PORT, path: '/tts' };
  },
};
