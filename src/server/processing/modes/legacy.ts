import { createPythonServiceController, buildLegacyServiceEnv } from '../process-service.js';
import type { ProcessingModeAdapter } from '../types.js';

const service = createPythonServiceController({
  scriptName: 'transcription-service.py',
  port: 3001,
  envFactory: () => buildLegacyServiceEnv(),
  logPrefix: '[python]',
});

export const legacyProcessingMode: ProcessingModeAdapter = {
  id: 'legacy',
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
    return { hostname: '127.0.0.1', port: 3001, path: '/tts' };
  },
};
