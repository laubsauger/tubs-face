const {
  startRealtimeProcessingService,
  stopRealtimeProcessingService,
  restartRealtimeProcessingService,
  transcribeAudioRealtime,
  getRealtimeTtsProxyTarget,
} = require('../../realtime-service');

module.exports = {
  id: 'realtime',
  startProcessingStack({ sttModel } = {}) {
    return startRealtimeProcessingService({ sttModel });
  },
  stopProcessingStack(timeoutMs = 5000) {
    return stopRealtimeProcessingService(timeoutMs);
  },
  restartTranscriptionService(modelName, reason = 'runtime config update') {
    return restartRealtimeProcessingService(modelName, reason);
  },
  transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
    return transcribeAudioRealtime(audioBuffer, mimeType);
  },
  getTtsProxyTarget() {
    return getRealtimeTtsProxyTarget();
  },
};
