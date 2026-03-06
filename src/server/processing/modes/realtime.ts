import { createPythonServiceController, buildRealtimeServiceEnv } from '../process-service.js';
import type { ProcessingModeAdapter } from '../types.js';

const service = createPythonServiceController({
  scriptName: 'realtime-processing-service.py',
  port: 3002,
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
    return { hostname: '127.0.0.1', port: 3002, path: '/tts' };
  },
};
