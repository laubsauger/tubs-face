const { runtimeConfig, normalizeProcessingMode } = require('../config');
const legacyMode = require('./modes/legacy');
const realtimeMode = require('./modes/realtime');

const MODE_REGISTRY = {
  legacy: legacyMode,
  realtime: realtimeMode,
};

function resolveProcessingMode(input) {
  const normalized = normalizeProcessingMode(input || runtimeConfig.processingMode || 'legacy');
  if (!MODE_REGISTRY[normalized]) {
    const err = new Error(`Unsupported processing mode: ${normalized}`);
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

const activeModeName = resolveProcessingMode(runtimeConfig.processingMode);
const activeMode = MODE_REGISTRY[activeModeName];
runtimeConfig.processingMode = activeModeName;

function getProcessingMode() {
  return activeModeName;
}

function getModeAdapter() {
  return activeMode;
}

function startProcessingStack(options = {}) {
  return activeMode.startProcessingStack(options);
}

function stopProcessingStack(timeoutMs = 5000) {
  return activeMode.stopProcessingStack(timeoutMs);
}

function restartTranscriptionService(modelName, reason = 'runtime config update') {
  return activeMode.restartTranscriptionService(modelName, reason);
}

function transcribeAudio(audioBuffer, mimeType = 'audio/webm') {
  return activeMode.transcribeAudio(audioBuffer, mimeType);
}

function getTtsProxyTarget() {
  if (typeof activeMode.getTtsProxyTarget === 'function') {
    return activeMode.getTtsProxyTarget();
  }
  return {
    hostname: 'localhost',
    port: 3001,
    path: '/tts',
  };
}

module.exports = {
  getProcessingMode,
  getModeAdapter,
  startProcessingStack,
  stopProcessingStack,
  restartTranscriptionService,
  transcribeAudio,
  getTtsProxyTarget,
};
