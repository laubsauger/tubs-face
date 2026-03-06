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
  GlitchRenderer,
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
  GLITCH_RENDERERS,
  KOKORO_VOICES,
  PROCESSING_MODES,
  RENDER_QUALITIES,
  STT_BACKENDS,
  TTS_BACKENDS,
} from '../../shared/contracts/config.js';

const DEFAULT_PROCESSING_MODE: ProcessingMode = pickOne(PROCESSING_MODES, process.env.PROCESSING_MODE, 'legacy');
const DEFAULT_STT_MODEL = process.env.WHISPER_MODEL?.trim() || 'small';
const DEFAULT_LLM_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
const DEFAULT_GLITCH_RENDERER: GlitchRenderer = pickOne(GLITCH_RENDERERS, process.env.GLITCH_RENDERER, 'auto');

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
  faceRenderMode: pickOne(FACE_RENDER_MODES, process.env.FACE_RENDER_MODE, 'glitch'),
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
  glitchRenderer: DEFAULT_GLITCH_RENDERER,
  glitchScanlines: parseBoolean(process.env.GLITCH_SCANLINES, true),
  glitchScanlineIntensity: parseFloatInRange(process.env.GLITCH_SCANLINE_INTENSITY, 0.41, 0, 1),
  glitchScanlineSpacing: parseIntegerInRange(process.env.GLITCH_SCANLINE_SPACING, 5, 1, 20),
  glitchScanlineThickness: parseIntegerInRange(process.env.GLITCH_SCANLINE_THICKNESS, 3, 1, 10),
  glitchScanlineSpeed: parseIntegerInRange(process.env.GLITCH_SCANLINE_SPEED, 26, 1, 60),
  glitchPixelJitter: parseFloatInRange(process.env.GLITCH_PIXEL_JITTER, 0, 0, 10),
  glitchFlicker: parseBoolean(process.env.GLITCH_FLICKER, true),
  glitchFlickerSpeed: parseIntegerInRange(process.env.GLITCH_FLICKER_SPEED, 11, 1, 30),
  glitchFlickerDepth: parseFloatInRange(process.env.GLITCH_FLICKER_DEPTH, 0.02, 0, 0.2),
  glitchGlowStrength: parseFloatInRange(process.env.GLITCH_GLOW_STRENGTH, 14, 0, 60),
  glitchBrightnessPulseEnabled: parseBoolean(process.env.GLITCH_BRIGHTNESS_PULSE_ENABLED, true),
  glitchBrightnessPulseDim: parseFloatInRange(process.env.GLITCH_BRIGHTNESS_PULSE_DIM, 0.88, 0.3, 1),
  glitchBrightnessPulseBright: parseFloatInRange(process.env.GLITCH_BRIGHTNESS_PULSE_BRIGHT, 1, 0.5, 1.5),
  glitchBrightnessPulseSpeed: parseFloatInRange(process.env.GLITCH_BRIGHTNESS_PULSE_SPEED, 3, 0.5, 15),
  glitchScanBeamEnabled: parseBoolean(process.env.GLITCH_SCAN_BEAM_ENABLED, true),
  glitchScanBeamSpeed: parseFloatInRange(process.env.GLITCH_SCAN_BEAM_SPEED, 10, 1, 40),
  glitchScanBeamLineWidth: parseFloatInRange(process.env.GLITCH_SCAN_BEAM_LINE_WIDTH, 7, 1, 30),
  glitchScanBeamBrightness: parseFloatInRange(process.env.GLITCH_SCAN_BEAM_BRIGHTNESS, 0.65, 0, 1),
  glitchScanBeamGlowStrength: parseFloatInRange(process.env.GLITCH_SCAN_BEAM_GLOW_STRENGTH, 26, 0, 60),
  glitchScanBeamJitter: parseFloatInRange(process.env.GLITCH_SCAN_BEAM_JITTER, 1, 0, 10),
  glitchScanBeamColor: normalizeHexColor(process.env.GLITCH_SCAN_BEAM_COLOR, '#a600ff'),
  glitchChromaticEnabled: parseBoolean(process.env.GLITCH_CHROMATIC_ENABLED, true),
  glitchChromaticOffsetX: parseFloatInRange(process.env.GLITCH_CHROMATIC_OFFSET_X, 0, -10, 10),
  glitchChromaticOffsetY: parseFloatInRange(process.env.GLITCH_CHROMATIC_OFFSET_Y, 4.5, -10, 10),
  glitchChromaticIntensity: parseFloatInRange(process.env.GLITCH_CHROMATIC_INTENSITY, 0.65, 0, 1),
  glitchChromaticAnimate: parseBoolean(process.env.GLITCH_CHROMATIC_ANIMATE, true),
  glitchChromaticAnimateSpeed: parseFloatInRange(process.env.GLITCH_CHROMATIC_ANIMATE_SPEED, 7, 1, 20),
  glitchSliceEnabled: parseBoolean(process.env.GLITCH_SLICE_ENABLED, true),
  glitchSliceCount: parseIntegerInRange(process.env.GLITCH_SLICE_COUNT, 24, 2, 60),
  glitchSliceMaxOffset: parseFloatInRange(process.env.GLITCH_SLICE_MAX_OFFSET, 5, 0, 30),
  glitchSliceSpeed: parseFloatInRange(process.env.GLITCH_SLICE_SPEED, 28, 1, 60),
  glitchSliceIntensity: parseFloatInRange(process.env.GLITCH_SLICE_INTENSITY, 0.53, 0, 1),
  glitchSliceColorShift: parseFloatInRange(process.env.GLITCH_SLICE_COLOR_SHIFT, 0.03, 0, 0.2),
  glitchSliceGapChance: parseFloatInRange(process.env.GLITCH_SLICE_GAP_CHANCE, 0.07, 0, 0.5),
  glitchSliceIntervalMs: parseIntegerInRange(process.env.GLITCH_SLICE_INTERVAL_MS, 18000, 1000, 60000),
  glitchSliceBurstDurationMs: parseIntegerInRange(process.env.GLITCH_SLICE_BURST_DURATION_MS, 1800, 200, 8000),
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
  if (patch.glitchRenderer !== undefined) {
    runtimeConfig.glitchRenderer = expectOne(GLITCH_RENDERERS, patch.glitchRenderer, 'glitchRenderer');
  }
  if (patch.glitchScanlines !== undefined) runtimeConfig.glitchScanlines = Boolean(patch.glitchScanlines);
  if (patch.glitchScanlineIntensity !== undefined) {
    runtimeConfig.glitchScanlineIntensity = parseFloatInRange(
      patch.glitchScanlineIntensity,
      runtimeConfig.glitchScanlineIntensity,
      0,
      1,
    );
  }
  if (patch.glitchScanlineSpacing !== undefined) {
    runtimeConfig.glitchScanlineSpacing = parseIntegerInRange(
      patch.glitchScanlineSpacing,
      runtimeConfig.glitchScanlineSpacing,
      1,
      20,
    );
  }
  if (patch.glitchScanlineThickness !== undefined) {
    runtimeConfig.glitchScanlineThickness = parseIntegerInRange(
      patch.glitchScanlineThickness,
      runtimeConfig.glitchScanlineThickness,
      1,
      10,
    );
  }
  if (patch.glitchScanlineSpeed !== undefined) {
    runtimeConfig.glitchScanlineSpeed = parseIntegerInRange(
      patch.glitchScanlineSpeed,
      runtimeConfig.glitchScanlineSpeed,
      1,
      60,
    );
  }
  if (patch.glitchPixelJitter !== undefined) {
    runtimeConfig.glitchPixelJitter = parseFloatInRange(patch.glitchPixelJitter, runtimeConfig.glitchPixelJitter, 0, 10);
  }
  if (patch.glitchFlicker !== undefined) runtimeConfig.glitchFlicker = Boolean(patch.glitchFlicker);
  if (patch.glitchFlickerSpeed !== undefined) {
    runtimeConfig.glitchFlickerSpeed = parseIntegerInRange(
      patch.glitchFlickerSpeed,
      runtimeConfig.glitchFlickerSpeed,
      1,
      30,
    );
  }
  if (patch.glitchFlickerDepth !== undefined) {
    runtimeConfig.glitchFlickerDepth = parseFloatInRange(patch.glitchFlickerDepth, runtimeConfig.glitchFlickerDepth, 0, 0.2);
  }
  if (patch.glitchGlowStrength !== undefined) {
    runtimeConfig.glitchGlowStrength = parseFloatInRange(patch.glitchGlowStrength, runtimeConfig.glitchGlowStrength, 0, 60);
  }
  if (patch.glitchBrightnessPulseEnabled !== undefined) {
    runtimeConfig.glitchBrightnessPulseEnabled = Boolean(patch.glitchBrightnessPulseEnabled);
  }
  if (patch.glitchBrightnessPulseDim !== undefined) {
    runtimeConfig.glitchBrightnessPulseDim = parseFloatInRange(
      patch.glitchBrightnessPulseDim,
      runtimeConfig.glitchBrightnessPulseDim,
      0.3,
      1,
    );
  }
  if (patch.glitchBrightnessPulseBright !== undefined) {
    runtimeConfig.glitchBrightnessPulseBright = parseFloatInRange(
      patch.glitchBrightnessPulseBright,
      runtimeConfig.glitchBrightnessPulseBright,
      0.5,
      1.5,
    );
  }
  if (patch.glitchBrightnessPulseSpeed !== undefined) {
    runtimeConfig.glitchBrightnessPulseSpeed = parseFloatInRange(
      patch.glitchBrightnessPulseSpeed,
      runtimeConfig.glitchBrightnessPulseSpeed,
      0.5,
      15,
    );
  }
  if (patch.glitchScanBeamEnabled !== undefined) runtimeConfig.glitchScanBeamEnabled = Boolean(patch.glitchScanBeamEnabled);
  if (patch.glitchScanBeamSpeed !== undefined) {
    runtimeConfig.glitchScanBeamSpeed = parseFloatInRange(patch.glitchScanBeamSpeed, runtimeConfig.glitchScanBeamSpeed, 1, 40);
  }
  if (patch.glitchScanBeamLineWidth !== undefined) {
    runtimeConfig.glitchScanBeamLineWidth = parseFloatInRange(
      patch.glitchScanBeamLineWidth,
      runtimeConfig.glitchScanBeamLineWidth,
      1,
      30,
    );
  }
  if (patch.glitchScanBeamBrightness !== undefined) {
    runtimeConfig.glitchScanBeamBrightness = parseFloatInRange(
      patch.glitchScanBeamBrightness,
      runtimeConfig.glitchScanBeamBrightness,
      0,
      1,
    );
  }
  if (patch.glitchScanBeamGlowStrength !== undefined) {
    runtimeConfig.glitchScanBeamGlowStrength = parseFloatInRange(
      patch.glitchScanBeamGlowStrength,
      runtimeConfig.glitchScanBeamGlowStrength,
      0,
      60,
    );
  }
  if (patch.glitchScanBeamJitter !== undefined) {
    runtimeConfig.glitchScanBeamJitter = parseFloatInRange(
      patch.glitchScanBeamJitter,
      runtimeConfig.glitchScanBeamJitter,
      0,
      10,
    );
  }
  if (patch.glitchScanBeamColor !== undefined) {
    runtimeConfig.glitchScanBeamColor = normalizeHexColor(patch.glitchScanBeamColor, runtimeConfig.glitchScanBeamColor);
  }
  if (patch.glitchChromaticEnabled !== undefined) {
    runtimeConfig.glitchChromaticEnabled = Boolean(patch.glitchChromaticEnabled);
  }
  if (patch.glitchChromaticOffsetX !== undefined) {
    runtimeConfig.glitchChromaticOffsetX = parseFloatInRange(
      patch.glitchChromaticOffsetX,
      runtimeConfig.glitchChromaticOffsetX,
      -10,
      10,
    );
  }
  if (patch.glitchChromaticOffsetY !== undefined) {
    runtimeConfig.glitchChromaticOffsetY = parseFloatInRange(
      patch.glitchChromaticOffsetY,
      runtimeConfig.glitchChromaticOffsetY,
      -10,
      10,
    );
  }
  if (patch.glitchChromaticIntensity !== undefined) {
    runtimeConfig.glitchChromaticIntensity = parseFloatInRange(
      patch.glitchChromaticIntensity,
      runtimeConfig.glitchChromaticIntensity,
      0,
      1,
    );
  }
  if (patch.glitchChromaticAnimate !== undefined) {
    runtimeConfig.glitchChromaticAnimate = Boolean(patch.glitchChromaticAnimate);
  }
  if (patch.glitchChromaticAnimateSpeed !== undefined) {
    runtimeConfig.glitchChromaticAnimateSpeed = parseFloatInRange(
      patch.glitchChromaticAnimateSpeed,
      runtimeConfig.glitchChromaticAnimateSpeed,
      1,
      20,
    );
  }
  if (patch.glitchSliceEnabled !== undefined) runtimeConfig.glitchSliceEnabled = Boolean(patch.glitchSliceEnabled);
  if (patch.glitchSliceCount !== undefined) {
    runtimeConfig.glitchSliceCount = parseIntegerInRange(patch.glitchSliceCount, runtimeConfig.glitchSliceCount, 2, 60);
  }
  if (patch.glitchSliceMaxOffset !== undefined) {
    runtimeConfig.glitchSliceMaxOffset = parseFloatInRange(
      patch.glitchSliceMaxOffset,
      runtimeConfig.glitchSliceMaxOffset,
      0,
      30,
    );
  }
  if (patch.glitchSliceSpeed !== undefined) {
    runtimeConfig.glitchSliceSpeed = parseFloatInRange(patch.glitchSliceSpeed, runtimeConfig.glitchSliceSpeed, 1, 60);
  }
  if (patch.glitchSliceIntensity !== undefined) {
    runtimeConfig.glitchSliceIntensity = parseFloatInRange(
      patch.glitchSliceIntensity,
      runtimeConfig.glitchSliceIntensity,
      0,
      1,
    );
  }
  if (patch.glitchSliceColorShift !== undefined) {
    runtimeConfig.glitchSliceColorShift = parseFloatInRange(
      patch.glitchSliceColorShift,
      runtimeConfig.glitchSliceColorShift,
      0,
      0.2,
    );
  }
  if (patch.glitchSliceGapChance !== undefined) {
    runtimeConfig.glitchSliceGapChance = parseFloatInRange(
      patch.glitchSliceGapChance,
      runtimeConfig.glitchSliceGapChance,
      0,
      0.5,
    );
  }
  if (patch.glitchSliceIntervalMs !== undefined) {
    runtimeConfig.glitchSliceIntervalMs = parseIntegerInRange(
      patch.glitchSliceIntervalMs,
      runtimeConfig.glitchSliceIntervalMs,
      1000,
      60000,
    );
  }
  if (patch.glitchSliceBurstDurationMs !== undefined) {
    runtimeConfig.glitchSliceBurstDurationMs = parseIntegerInRange(
      patch.glitchSliceBurstDurationMs,
      runtimeConfig.glitchSliceBurstDurationMs,
      200,
      8000,
    );
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
