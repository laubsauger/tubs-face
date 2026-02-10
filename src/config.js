const DEFAULT_STT_MODEL = process.env.WHISPER_MODEL || 'small';

const sessionStats = {
  messagesIn: 0,
  messagesOut: 0,
  tokensIn: 0,
  tokensOut: 0,
  uptime: Date.now(),
  lastActivity: null,
  model: 'Tubs Bot v1',
};

const runtimeConfig = {
  sleepTimeout: 10000,
  model: 'Tubs Bot v1',
  prompt: 'Default personality',
  sttModel: DEFAULT_STT_MODEL,
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

module.exports = { sessionStats, runtimeConfig, normalizeSttModel, DEFAULT_STT_MODEL };
