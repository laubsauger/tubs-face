const {
  startTranscriptionService,
  stopTranscriptionService,
  restartTranscriptionService,
  transcribeAudio,
} = require('../../python-service');

function getTtsProxyTarget() {
  return {
    hostname: 'localhost',
    port: 3001,
    path: '/tts',
  };
}

module.exports = {
  id: 'legacy',
  startProcessingStack({ sttModel } = {}) {
    startTranscriptionService(sttModel);
  },
  stopProcessingStack(timeoutMs = 5000) {
    return stopTranscriptionService(timeoutMs);
  },
  restartTranscriptionService(modelName, reason = 'runtime config update') {
    return restartTranscriptionService(modelName, reason);
  },
  transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
    return transcribeAudio(audioBuffer, mimeType);
  },
  getTtsProxyTarget,
};
