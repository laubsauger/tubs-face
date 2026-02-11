const { loadEnvFile } = require('./env');
loadEnvFile();

/* --- 1. Constants & Sets --- */
const KOKORO_VOICES = new Set([
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore',
  'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
  'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  'ef_dora', 'em_alex', 'em_santa',
  'ff_siwis',
  'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  'if_sara', 'im_nicola',
  'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
  'pf_dora', 'pm_alex', 'pm_santa',
  'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
  'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
]);

/* --- 2. Helper Functions (Hoisted) --- */
function normalizeKokoroVoice(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!KOKORO_VOICES.has(normalized)) {
    // Only throw if strictly validating, or fallback?
    // The previous code threw.
    const err = new Error(`kokoroVoice must be one of: ${[...KOKORO_VOICES].join(', ')}`);
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

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
  if (!Number.isFinite(parsed) || parsed < 32 || parsed > 1024) {
    const err = new Error('llmMaxOutputTokens must be an integer between 32 and 1024');
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

function normalizeMinFaceBoxAreaRatio(value) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.2) {
    const err = new Error('minFaceBoxAreaRatio must be a number between 0 and 0.2');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return parsed;
}

function normalizeFaceRenderMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['css', 'svg']);
  if (!allowed.has(normalized)) {
    const err = new Error('faceRenderMode must be one of: css, svg');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

function normalizeTtsBackend(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['kokoro', 'system']);
  if (!allowed.has(normalized)) {
    const err = new Error('ttsBackend must be one of: kokoro, system');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

function normalizeSttBackend(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['mlx', 'faster-whisper']);
  if (!allowed.has(normalized)) {
    const err = new Error('sttBackend must be one of: mlx, faster-whisper');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}


/* --- 3. Resolved Configuration --- */
const DEFAULT_STT_MODEL = process.env.WHISPER_MODEL || 'large-v3-turbo';
const DEFAULT_LLM_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DEFAULT_LLM_MAX_OUTPUT_TOKENS = normalizeLlmMaxOutputTokens(process.env.GEMINI_MAX_OUTPUT_TOKENS || 256);
const DEFAULT_DONATION_SIGNAL_MODE = normalizeDonationSignalMode(process.env.DONATION_SIGNAL_MODE || 'both');
const DEFAULT_MIN_FACE_BOX_AREA_RATIO = normalizeMinFaceBoxAreaRatio(process.env.MIN_FACE_BOX_AREA_RATIO || 0.02);
const DEFAULT_FACE_RENDER_MODE = normalizeFaceRenderMode(process.env.FACE_RENDER_MODE || 'svg');
const DEFAULT_TTS_BACKEND = normalizeTtsBackend(process.env.TTS_BACKEND || 'kokoro');
const DEFAULT_STT_BACKEND = normalizeSttBackend(process.env.STT_BACKEND || 'mlx');
const DEFAULT_KOKORO_VOICE = normalizeKokoroVoice(process.env.KOKORO_VOICE || 'af_heart');

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
  minFaceBoxAreaRatio: DEFAULT_MIN_FACE_BOX_AREA_RATIO,
  faceRenderMode: DEFAULT_FACE_RENDER_MODE,
  ttsBackend: DEFAULT_TTS_BACKEND,
  sttBackend: DEFAULT_STT_BACKEND,
  kokoroVoice: DEFAULT_KOKORO_VOICE,
};




module.exports = {
  sessionStats,
  runtimeConfig,
  normalizeSttModel,
  normalizeLlmModel,
  normalizeLlmMaxOutputTokens,
  normalizeDonationSignalMode,
  normalizeMinFaceBoxAreaRatio,
  normalizeFaceRenderMode,
  DEFAULT_STT_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_DONATION_SIGNAL_MODE,
  DEFAULT_MIN_FACE_BOX_AREA_RATIO,
  DEFAULT_FACE_RENDER_MODE,
  DEFAULT_TTS_BACKEND,
  DEFAULT_STT_BACKEND,
  DEFAULT_KOKORO_VOICE,
  normalizeTtsBackend,
  normalizeSttBackend,
  normalizeKokoroVoice,
};
