const { loadEnvFile } = require('./env');
loadEnvFile();

const DEFAULT_STT_MODEL = process.env.WHISPER_MODEL || 'small';
const DEFAULT_LLM_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DEFAULT_LLM_MAX_OUTPUT_TOKENS = normalizeLlmMaxOutputTokens(process.env.GEMINI_MAX_OUTPUT_TOKENS || 120);
const DEFAULT_DONATION_SIGNAL_MODE = normalizeDonationSignalMode(process.env.DONATION_SIGNAL_MODE || 'both');

const sessionStats = {
  messagesIn: 0,
  messagesOut: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  uptime: Date.now(),
  lastActivity: null,
  model: 'Tubs Bot v1',
};

const runtimeConfig = {
  sleepTimeout: 10000,
  model: 'Tubs Bot v1',
  prompt: 'Default personality',
  sttModel: DEFAULT_STT_MODEL,
  llmModel: DEFAULT_LLM_MODEL,
  llmMaxOutputTokens: DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  donationSignalMode: DEFAULT_DONATION_SIGNAL_MODE,
};

function normalizeSttModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) {
    const err = new Error('sttModel must be a non-empty string');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    const err = new Error('sttModel contains invalid characters');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

function normalizeLlmModel(model) {
  const normalized = String(model || '').trim();
  if (!normalized) {
    const err = new Error('llmModel must be a non-empty string');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    const err = new Error('llmModel contains invalid characters');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

function normalizeLlmMaxOutputTokens(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 32 || parsed > 512) {
    const err = new Error('llmMaxOutputTokens must be an integer between 32 and 512');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return parsed;
}

function normalizeDonationSignalMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['both', 'implied', 'confident', 'off']);
  if (!allowed.has(normalized)) {
    const err = new Error('donationSignalMode must be one of: both, implied, confident, off');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

module.exports = {
  sessionStats,
  runtimeConfig,
  normalizeSttModel,
  normalizeLlmModel,
  normalizeLlmMaxOutputTokens,
  normalizeDonationSignalMode,
  DEFAULT_STT_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_DONATION_SIGNAL_MODE,
};
