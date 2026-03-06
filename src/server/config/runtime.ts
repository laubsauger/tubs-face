import type {
  ConfigResponse,
  HealthResponse,
  StatsResponse,
} from '../../shared/contracts/http.js';
import type {
  DonationSignalMode,
  DualHeadMode,
  DualHeadTurnPolicy,
  FaceRenderMode,
  KokoroVoice,
  ProcessingMode,
  RenderQuality,
  RuntimeConfig,
  SessionStats,
  SttBackend,
  TtsBackend,
} from '../../shared/contracts/config.js';
import {
  DONATION_SIGNAL_MODES,
  DUAL_HEAD_MODES,
  DUAL_HEAD_TURN_POLICIES,
  FACE_RENDER_MODES,
  KOKORO_VOICES,
  PROCESSING_MODES,
  RENDER_QUALITIES,
  STT_BACKENDS,
  TTS_BACKENDS,
} from '../../shared/contracts/config.js';

const DEFAULT_PROCESSING_MODE: ProcessingMode = pickOne(PROCESSING_MODES, process.env.PROCESSING_MODE, 'legacy');
const DEFAULT_STT_MODEL = process.env.WHISPER_MODEL?.trim() || 'small';
const DEFAULT_LLM_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

export const runtimeConfig: RuntimeConfig = {
  processingMode: DEFAULT_PROCESSING_MODE,
  sleepTimeout: 10000,
  model: 'Tubs Bot v1',
  prompt: 'Default personality',
  sttModel: DEFAULT_STT_MODEL,
  llmModel: DEFAULT_LLM_MODEL,
  llmMaxOutputTokens: parseIntegerInRange(process.env.GEMINI_MAX_OUTPUT_TOKENS, 256, 32, 1024),
  donationSignalMode: pickOne(DONATION_SIGNAL_MODES, process.env.DONATION_SIGNAL_MODE, 'both'),
  minFaceBoxAreaRatio: parseFloatInRange(process.env.MIN_FACE_BOX_AREA_RATIO, 0.02, 0, 0.2),
  faceRenderMode: pickOne(FACE_RENDER_MODES, process.env.FACE_RENDER_MODE, 'svg'),
  renderQuality: pickOne(RENDER_QUALITIES, process.env.RENDER_QUALITY, 'high'),
  ttsBackend: pickOne(TTS_BACKENDS, process.env.TTS_BACKEND, 'vibevoice'),
  sttBackend: pickOne(STT_BACKENDS, process.env.STT_BACKEND, 'mlx'),
  kokoroVoice: pickOne(KOKORO_VOICES, process.env.KOKORO_VOICE, 'hm_omega'),
  dualHeadEnabled: parseBoolean(process.env.DUAL_HEAD_ENABLED, false),
  dualHeadMode: pickOne(DUAL_HEAD_MODES, process.env.DUAL_HEAD_MODE, 'off'),
  secondaryVoice: pickOne(KOKORO_VOICES, process.env.SECONDARY_VOICE, 'jf_tebukuro'),
  secondaryRenderQuality: pickOne(RENDER_QUALITIES, process.env.SECONDARY_RENDER_QUALITY, 'balanced'),
  secondarySubtitleEnabled: parseBoolean(process.env.SECONDARY_SUBTITLE_ENABLED, true),
  secondaryAudioGain: parseFloatInRange(process.env.SECONDARY_AUDIO_GAIN, 1.0, 0, 1.2),
  dualHeadTurnPolicy: pickOne(DUAL_HEAD_TURN_POLICIES, process.env.DUAL_HEAD_TURN_POLICY, 'llm_order'),
  muted: parseBoolean(process.env.MUTED, false),
  ambientAudioEnabled: parseBoolean(process.env.AMBIENT_AUDIO_ENABLED, true),
  glitchFxEnabled: true,
  glitchFxBaseColor: normalizeHexColor(process.env.GLITCH_FX_BASE_COLOR, '#a855f7'),
  secondaryGlitchFxBaseColor: normalizeHexColor(process.env.SECONDARY_GLITCH_FX_BASE_COLOR, '#22d3ee'),
  ttsStreamingEnabled: parseBoolean(process.env.TTS_STREAMING_ENABLED, true),
  vadNoiseGate: parseFloatInRange(process.env.VAD_NOISE_GATE, 0.008, 0, 0.06),
};

export const sessionStats: SessionStats = {
  messagesIn: 0,
  messagesOut: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  uptime: Date.now(),
  lastActivity: null,
  model: runtimeConfig.model,
};

export interface RuntimeContext {
  readonly runtimeConfig: RuntimeConfig;
  readonly sessionStats: SessionStats;
}

export function getRuntimeContext(): RuntimeContext {
  return { runtimeConfig, sessionStats };
}

export function toHealthResponse(clientCount: number): HealthResponse {
  return {
    status: 'ok',
    clients: clientCount,
    uptime: Math.floor((Date.now() - sessionStats.uptime) / 1000),
    processingMode: runtimeConfig.processingMode,
    service: 'tubs-face',
    mode: 'typescript',
  };
}

export function toStatsResponse(): StatsResponse {
  return { ...sessionStats };
}

export function toConfigResponse(): ConfigResponse {
  return { ...runtimeConfig };
}

export type RuntimeConfigPatch = Partial<RuntimeConfig>;

export function applyRuntimeConfigPatch(patch: RuntimeConfigPatch): ConfigResponse {
  if (patch.sleepTimeout !== undefined) {
    runtimeConfig.sleepTimeout = parseIntegerInRange(patch.sleepTimeout, runtimeConfig.sleepTimeout, 5000, 600000);
  }
  if (patch.model !== undefined) runtimeConfig.model = requireNonEmptyString(patch.model, 'model');
  if (patch.prompt !== undefined) runtimeConfig.prompt = requireNonEmptyString(patch.prompt, 'prompt');
  if (patch.sttModel !== undefined) runtimeConfig.sttModel = requireTokenString(patch.sttModel, 'sttModel');
  if (patch.llmModel !== undefined) runtimeConfig.llmModel = requireNonEmptyString(patch.llmModel, 'llmModel');
  if (patch.llmMaxOutputTokens !== undefined) {
    runtimeConfig.llmMaxOutputTokens = parseIntegerInRange(patch.llmMaxOutputTokens, runtimeConfig.llmMaxOutputTokens, 32, 1024);
  }
  if (patch.donationSignalMode !== undefined) {
    runtimeConfig.donationSignalMode = expectOne(DONATION_SIGNAL_MODES, patch.donationSignalMode, 'donationSignalMode');
  }
  if (patch.minFaceBoxAreaRatio !== undefined) {
    runtimeConfig.minFaceBoxAreaRatio = parseFloatInRange(patch.minFaceBoxAreaRatio, runtimeConfig.minFaceBoxAreaRatio, 0, 0.2);
  }
  if (patch.faceRenderMode !== undefined) {
    runtimeConfig.faceRenderMode = expectOne(FACE_RENDER_MODES, patch.faceRenderMode, 'faceRenderMode');
  }
  if (patch.renderQuality !== undefined) {
    runtimeConfig.renderQuality = expectOne(RENDER_QUALITIES, patch.renderQuality, 'renderQuality');
  }
  if (patch.ttsBackend !== undefined) {
    runtimeConfig.ttsBackend = expectOne(TTS_BACKENDS, patch.ttsBackend, 'ttsBackend');
  }
  if (patch.sttBackend !== undefined) {
    runtimeConfig.sttBackend = expectOne(STT_BACKENDS, patch.sttBackend, 'sttBackend');
  }
  if (patch.kokoroVoice !== undefined) {
    runtimeConfig.kokoroVoice = expectOne(KOKORO_VOICES, patch.kokoroVoice, 'kokoroVoice');
  }
  if (patch.dualHeadEnabled !== undefined) runtimeConfig.dualHeadEnabled = Boolean(patch.dualHeadEnabled);
  if (patch.dualHeadMode !== undefined) {
    runtimeConfig.dualHeadMode = expectOne(DUAL_HEAD_MODES, patch.dualHeadMode, 'dualHeadMode');
  }
  if (patch.secondaryVoice !== undefined) {
    runtimeConfig.secondaryVoice = expectOne(KOKORO_VOICES, patch.secondaryVoice, 'secondaryVoice');
  }
  if (patch.secondaryRenderQuality !== undefined) {
    runtimeConfig.secondaryRenderQuality = expectOne(RENDER_QUALITIES, patch.secondaryRenderQuality, 'secondaryRenderQuality');
  }
  if (patch.secondarySubtitleEnabled !== undefined) runtimeConfig.secondarySubtitleEnabled = Boolean(patch.secondarySubtitleEnabled);
  if (patch.secondaryAudioGain !== undefined) {
    runtimeConfig.secondaryAudioGain = parseFloatInRange(patch.secondaryAudioGain, runtimeConfig.secondaryAudioGain, 0, 1.2);
  }
  if (patch.dualHeadTurnPolicy !== undefined) {
    runtimeConfig.dualHeadTurnPolicy = expectOne(DUAL_HEAD_TURN_POLICIES, patch.dualHeadTurnPolicy, 'dualHeadTurnPolicy');
  }
  if (patch.muted !== undefined) runtimeConfig.muted = Boolean(patch.muted);
  if (patch.ambientAudioEnabled !== undefined) runtimeConfig.ambientAudioEnabled = Boolean(patch.ambientAudioEnabled);
  if (patch.glitchFxEnabled !== undefined) runtimeConfig.glitchFxEnabled = Boolean(patch.glitchFxEnabled);
  if (patch.glitchFxBaseColor !== undefined) {
    runtimeConfig.glitchFxBaseColor = normalizeHexColor(patch.glitchFxBaseColor, runtimeConfig.glitchFxBaseColor);
  }
  if (patch.secondaryGlitchFxBaseColor !== undefined) {
    runtimeConfig.secondaryGlitchFxBaseColor = normalizeHexColor(
      patch.secondaryGlitchFxBaseColor,
      runtimeConfig.secondaryGlitchFxBaseColor,
    );
  }
  if (patch.ttsStreamingEnabled !== undefined) runtimeConfig.ttsStreamingEnabled = Boolean(patch.ttsStreamingEnabled);
  if (patch.vadNoiseGate !== undefined) {
    runtimeConfig.vadNoiseGate = parseFloatInRange(patch.vadNoiseGate, runtimeConfig.vadNoiseGate ?? 0.008, 0, 0.06);
  }

  sessionStats.model = runtimeConfig.model;
  sessionStats.lastActivity = Date.now();

  return toConfigResponse();
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw badRequest(`${fieldName} must be a non-empty string`);
  }
  return normalized;
}

function requireTokenString(value: unknown, fieldName: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || !/^[a-z0-9._-]+$/.test(normalized)) {
    throw badRequest(`${fieldName} contains invalid characters`);
  }
  return normalized;
}

function normalizeHexColor(value: unknown, fallback: `#${string}`): `#${string}` {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) {
    return fallback;
  }
  return normalized as `#${string}`;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function parseIntegerInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function parseFloatInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(String(value ?? fallback));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function expectOne<T extends readonly string[]>(
  allowed: T,
  value: unknown,
  fieldName: string,
): T[number] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as T[number];
  }
  throw badRequest(`${fieldName} must be one of: ${allowed.join(', ')}`);
}

function pickOne<T extends readonly string[]>(allowed: T, value: unknown, fallback: T[number]): T[number] {
  const normalized = String(value ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T[number]) : fallback;
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = 'BadRequestError';
  return error;
}
