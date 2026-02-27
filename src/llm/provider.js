const { runtimeConfig } = require('../config');
const geminiProvider = require('./providers/gemini');
const realtimeProvider = require('./providers/realtime');

function resolveProvider() {
  const providerType = (process.env.LLM_PROVIDER || '').trim().toLowerCase();

  if (providerType === 'gemini') {
    return geminiProvider;
  } else if (providerType === 'realtime') {
    return realtimeProvider;
  }

  // Fallback to legacy behavior if not explicitly set
  return runtimeConfig.processingMode === 'realtime'
    ? realtimeProvider
    : geminiProvider;
}

function getLlmProviderId() {
  return resolveProvider().id;
}

function getLlmAuthState() {
  return resolveProvider().getAuthState();
}

async function generateLlmContent(args) {
  return resolveProvider().generateContent(args);
}

async function streamLlmContent(args) {
  return resolveProvider().streamContent(args);
}

module.exports = {
  getLlmProviderId,
  getLlmAuthState,
  generateLlmContent,
  streamLlmContent,
};
