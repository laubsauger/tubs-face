const { runtimeConfig } = require('../config');
const geminiProvider = require('./providers/gemini');
const realtimeProvider = require('./providers/realtime');

function resolveProvider() {
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
