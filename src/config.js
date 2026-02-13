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

function normalizeRenderQuality(value, fieldName = 'renderQuality') {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['high', 'balanced', 'low']);
  if (!allowed.has(normalized)) {
    const err = new Error(`${fieldName} must be one of: high, balanced, low`);
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

function normalizeHexColor(value, fieldName) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) {
    const err = new Error(`${fieldName} must be a valid hex color (e.g. #a855f7)`);
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

function normalizeBooleanConfig(value, fieldName) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  const err = new Error(`${fieldName} must be a boolean`);
  err.code = 'BAD_CONFIG';
  throw err;
}

function normalizeDualHeadMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['off', 'llm_directed', 'mirror']);
  if (!allowed.has(normalized)) {
    const err = new Error('dualHeadMode must be one of: off, llm_directed, mirror');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

function normalizeSecondaryAudioGain(value) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1.2) {
    const err = new Error('secondaryAudioGain must be a number between 0 and 1.2');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return parsed;
}

function normalizeDualHeadTurnPolicy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const allowed = new Set(['llm_order', 'main_first', 'small_first']);
  if (!allowed.has(normalized)) {
    const err = new Error('dualHeadTurnPolicy must be one of: llm_order, main_first, small_first');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}


/* --- 3. Resolved Configuration --- */
const DEFAULT_STT_MODEL = process.env.WHISPER_MODEL || 'small';
const DEFAULT_LLM_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DEFAULT_LLM_MAX_OUTPUT_TOKENS = normalizeLlmMaxOutputTokens(process.env.GEMINI_MAX_OUTPUT_TOKENS || 256);
const DEFAULT_DONATION_SIGNAL_MODE = normalizeDonationSignalMode(process.env.DONATION_SIGNAL_MODE || 'both');
const DEFAULT_MIN_FACE_BOX_AREA_RATIO = normalizeMinFaceBoxAreaRatio(process.env.MIN_FACE_BOX_AREA_RATIO || 0.02);
const DEFAULT_FACE_RENDER_MODE = normalizeFaceRenderMode(process.env.FACE_RENDER_MODE || 'svg');
const DEFAULT_RENDER_QUALITY = normalizeRenderQuality(process.env.RENDER_QUALITY || 'high', 'renderQuality');
const DEFAULT_TTS_BACKEND = normalizeTtsBackend(process.env.TTS_BACKEND || 'kokoro');
const DEFAULT_STT_BACKEND = normalizeSttBackend(process.env.STT_BACKEND || 'mlx');
const DEFAULT_KOKORO_VOICE = normalizeKokoroVoice(process.env.KOKORO_VOICE || 'hm_omega');
const DEFAULT_DUAL_HEAD_ENABLED = normalizeBooleanConfig(process.env.DUAL_HEAD_ENABLED || false, 'dualHeadEnabled');
const DEFAULT_DUAL_HEAD_MODE = normalizeDualHeadMode(process.env.DUAL_HEAD_MODE || 'off');
const DEFAULT_SECONDARY_VOICE = normalizeKokoroVoice(process.env.SECONDARY_VOICE || 'jf_tebukuro');
const DEFAULT_SECONDARY_RENDER_QUALITY = normalizeRenderQuality(process.env.SECONDARY_RENDER_QUALITY || 'balanced', 'secondaryRenderQuality');
const DEFAULT_SECONDARY_SUBTITLE_ENABLED = normalizeBooleanConfig(process.env.SECONDARY_SUBTITLE_ENABLED || true, 'secondarySubtitleEnabled');
const DEFAULT_SECONDARY_AUDIO_GAIN = normalizeSecondaryAudioGain(process.env.SECONDARY_AUDIO_GAIN || 1.0);
const DEFAULT_DUAL_HEAD_TURN_POLICY = normalizeDualHeadTurnPolicy(process.env.DUAL_HEAD_TURN_POLICY || 'llm_order');
const DEFAULT_MUTED = normalizeBooleanConfig(process.env.MUTED || false, 'muted');
const DEFAULT_AMBIENT_AUDIO_ENABLED = normalizeBooleanConfig(process.env.AMBIENT_AUDIO_ENABLED || true, 'ambientAudioEnabled');

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
  renderQuality: DEFAULT_RENDER_QUALITY,
  ttsBackend: DEFAULT_TTS_BACKEND,
  sttBackend: DEFAULT_STT_BACKEND,
  kokoroVoice: DEFAULT_KOKORO_VOICE,
  dualHeadEnabled: DEFAULT_DUAL_HEAD_ENABLED,
  dualHeadMode: DEFAULT_DUAL_HEAD_MODE,
  secondaryVoice: DEFAULT_SECONDARY_VOICE,
  secondaryRenderQuality: DEFAULT_SECONDARY_RENDER_QUALITY,
  secondarySubtitleEnabled: DEFAULT_SECONDARY_SUBTITLE_ENABLED,
  secondaryAudioGain: DEFAULT_SECONDARY_AUDIO_GAIN,
  dualHeadTurnPolicy: DEFAULT_DUAL_HEAD_TURN_POLICY,
  muted: DEFAULT_MUTED,
  ambientAudioEnabled: DEFAULT_AMBIENT_AUDIO_ENABLED,
  glitchFxEnabled: true,
  glitchFxBaseColor: '#a855f7',
  secondaryGlitchFxBaseColor: '#22d3ee',
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
  normalizeRenderQuality,
  DEFAULT_STT_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_DONATION_SIGNAL_MODE,
  DEFAULT_MIN_FACE_BOX_AREA_RATIO,
  DEFAULT_FACE_RENDER_MODE,
  DEFAULT_RENDER_QUALITY,
  DEFAULT_TTS_BACKEND,
  DEFAULT_STT_BACKEND,
  DEFAULT_KOKORO_VOICE,
  DEFAULT_DUAL_HEAD_ENABLED,
  DEFAULT_DUAL_HEAD_MODE,
  DEFAULT_SECONDARY_VOICE,
  DEFAULT_SECONDARY_RENDER_QUALITY,
  DEFAULT_SECONDARY_SUBTITLE_ENABLED,
  DEFAULT_SECONDARY_AUDIO_GAIN,
  DEFAULT_DUAL_HEAD_TURN_POLICY,
  DEFAULT_MUTED,
  DEFAULT_AMBIENT_AUDIO_ENABLED,
  normalizeTtsBackend,
  normalizeSttBackend,
  normalizeKokoroVoice,
  normalizeBooleanConfig,
  normalizeDualHeadMode,
  normalizeSecondaryAudioGain,
  normalizeDualHeadTurnPolicy,
  normalizeHexColor,
};
