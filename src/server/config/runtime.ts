import type {
  ConfigResponse,
  HealthResponse,
  StatsResponse,
} from '../../shared/contracts/http.js';
import type {
  DonationSignalMode,
  DualHeadMode,
  DualHeadTurnPolicy,
  ExpressionName,
  ExpressionProfile,
  ExpressionProfileMap,
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
  DEFAULT_EXPRESSION_PROFILES,
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
const DEFAULT_STT_MODEL = resolveProcessingEnv({
  legacy: process.env.WHISPER_MODEL,
  realtime: process.env.REALTIME_STT_MODEL,
})?.trim() || 'small';
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
  ttsBackend: pickOne(TTS_BACKENDS, resolveProcessingEnv({
    legacy: process.env.TTS_BACKEND,
    realtime: process.env.REALTIME_TTS_BACKEND,
  }), 'vibevoice'),
  sttBackend: pickOne(STT_BACKENDS, resolveProcessingEnv({
    legacy: process.env.STT_BACKEND,
    realtime: process.env.REALTIME_STT_BACKEND,
  }), 'mlx'),
  kokoroVoice: pickOne(KOKORO_VOICES, resolveProcessingEnv({
    legacy: process.env.KOKORO_VOICE,
    realtime: process.env.REALTIME_KOKORO_VOICE,
  }), 'hm_omega'),
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
  glitchExpressionProfiles: structuredClone(DEFAULT_EXPRESSION_PROFILES),
  glitchRenderer: DEFAULT_GLITCH_RENDERER,
  glitchPixelSize: parseFloatInRange(process.env.GLITCH_PIXEL_SIZE, 21, 2, 60),
  glitchPixelGap: parseFloatInRange(process.env.GLITCH_PIXEL_GAP, 7, 0, 30),
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
  glitchColorHueVariation: parseFloatInRange(process.env.GLITCH_COLOR_HUE_VARIATION, 8, 0, 60),
  glitchColorBrightnessVariation: parseFloatInRange(process.env.GLITCH_COLOR_BRIGHTNESS_VARIATION, 8, 0, 40),
  glitchColorOpacityMin: parseFloatInRange(process.env.GLITCH_COLOR_OPACITY_MIN, 0.5, 0, 1),
  glitchShapeLeftEyeX: parseFloatInRange(process.env.GLITCH_SHAPE_LEFT_EYE_X, 0, -10, 60),
  glitchShapeLeftEyeY: parseFloatInRange(process.env.GLITCH_SHAPE_LEFT_EYE_Y, 0, -10, 40),
  glitchShapeLeftEyeW: parseFloatInRange(process.env.GLITCH_SHAPE_LEFT_EYE_W, 14.59, 1, 30),
  glitchShapeLeftEyeH: parseFloatInRange(process.env.GLITCH_SHAPE_LEFT_EYE_H, 22.47, 1, 40),
  glitchShapeLeftEyeRx: parseFloatInRange(process.env.GLITCH_SHAPE_LEFT_EYE_RX, 5.94, 0, 15),
  glitchShapeLeftEyeRy: parseFloatInRange(process.env.GLITCH_SHAPE_LEFT_EYE_RY, 5.94, 0, 15),
  glitchShapeRightEyeX: parseFloatInRange(process.env.GLITCH_SHAPE_RIGHT_EYE_X, 40.85, 0, 60),
  glitchShapeRightEyeY: parseFloatInRange(process.env.GLITCH_SHAPE_RIGHT_EYE_Y, 0, -10, 40),
  glitchShapeRightEyeW: parseFloatInRange(process.env.GLITCH_SHAPE_RIGHT_EYE_W, 14.59, 1, 30),
  glitchShapeRightEyeH: parseFloatInRange(process.env.GLITCH_SHAPE_RIGHT_EYE_H, 22.47, 1, 40),
  glitchShapeRightEyeRx: parseFloatInRange(process.env.GLITCH_SHAPE_RIGHT_EYE_RX, 5.94, 0, 15),
  glitchShapeRightEyeRy: parseFloatInRange(process.env.GLITCH_SHAPE_RIGHT_EYE_RY, 5.94, 0, 15),
  glitchShapeMouthX: parseFloatInRange(process.env.GLITCH_SHAPE_MOUTH_X, 20.53, 0, 60),
  glitchShapeMouthY: parseFloatInRange(process.env.GLITCH_SHAPE_MOUTH_Y, 23.86, 0, 40),
  glitchShapeMouthW: parseFloatInRange(process.env.GLITCH_SHAPE_MOUTH_W, 14.38, 1, 30),
  glitchShapeMouthH: parseFloatInRange(process.env.GLITCH_SHAPE_MOUTH_H, 6.44, 1, 20),
  glitchShapeMouthRx: parseFloatInRange(process.env.GLITCH_SHAPE_MOUTH_RX, 1.95, 0, 15),
  glitchShapeMouthRy: parseFloatInRange(process.env.GLITCH_SHAPE_MOUTH_RY, 1.95, 0, 15),
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

function resolveProcessingEnv(values: { legacy: string | undefined; realtime: string | undefined }): string | undefined {
  if (DEFAULT_PROCESSING_MODE === 'realtime') {
    return values.realtime?.trim() || values.legacy?.trim();
  }

  return values.legacy?.trim() || values.realtime?.trim();
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
  if (patch.glitchExpressionProfiles !== undefined) {
    runtimeConfig.glitchExpressionProfiles = normalizeExpressionProfiles(
      patch.glitchExpressionProfiles,
      runtimeConfig.glitchExpressionProfiles,
    );
  }
  if (patch.glitchRenderer !== undefined) {
    runtimeConfig.glitchRenderer = expectOne(GLITCH_RENDERERS, patch.glitchRenderer, 'glitchRenderer');
  }
  if (patch.glitchPixelSize !== undefined) {
    runtimeConfig.glitchPixelSize = parseFloatInRange(patch.glitchPixelSize, runtimeConfig.glitchPixelSize, 2, 60);
  }
  if (patch.glitchPixelGap !== undefined) {
    runtimeConfig.glitchPixelGap = parseFloatInRange(patch.glitchPixelGap, runtimeConfig.glitchPixelGap, 0, 30);
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
  if (patch.glitchColorHueVariation !== undefined) {
    runtimeConfig.glitchColorHueVariation = parseFloatInRange(
      patch.glitchColorHueVariation,
      runtimeConfig.glitchColorHueVariation,
      0,
      60,
    );
  }
  if (patch.glitchColorBrightnessVariation !== undefined) {
    runtimeConfig.glitchColorBrightnessVariation = parseFloatInRange(
      patch.glitchColorBrightnessVariation,
      runtimeConfig.glitchColorBrightnessVariation,
      0,
      40,
    );
  }
  if (patch.glitchColorOpacityMin !== undefined) {
    runtimeConfig.glitchColorOpacityMin = parseFloatInRange(
      patch.glitchColorOpacityMin,
      runtimeConfig.glitchColorOpacityMin,
      0,
      1,
    );
  }
  if (patch.glitchShapeLeftEyeX !== undefined) {
    runtimeConfig.glitchShapeLeftEyeX = parseFloatInRange(patch.glitchShapeLeftEyeX, runtimeConfig.glitchShapeLeftEyeX, -10, 60);
  }
  if (patch.glitchShapeLeftEyeY !== undefined) {
    runtimeConfig.glitchShapeLeftEyeY = parseFloatInRange(patch.glitchShapeLeftEyeY, runtimeConfig.glitchShapeLeftEyeY, -10, 40);
  }
  if (patch.glitchShapeLeftEyeW !== undefined) {
    runtimeConfig.glitchShapeLeftEyeW = parseFloatInRange(patch.glitchShapeLeftEyeW, runtimeConfig.glitchShapeLeftEyeW, 1, 30);
  }
  if (patch.glitchShapeLeftEyeH !== undefined) {
    runtimeConfig.glitchShapeLeftEyeH = parseFloatInRange(patch.glitchShapeLeftEyeH, runtimeConfig.glitchShapeLeftEyeH, 1, 40);
  }
  if (patch.glitchShapeLeftEyeRx !== undefined) {
    runtimeConfig.glitchShapeLeftEyeRx = parseFloatInRange(patch.glitchShapeLeftEyeRx, runtimeConfig.glitchShapeLeftEyeRx, 0, 15);
  }
  if (patch.glitchShapeLeftEyeRy !== undefined) {
    runtimeConfig.glitchShapeLeftEyeRy = parseFloatInRange(patch.glitchShapeLeftEyeRy, runtimeConfig.glitchShapeLeftEyeRy, 0, 15);
  }
  if (patch.glitchShapeRightEyeX !== undefined) {
    runtimeConfig.glitchShapeRightEyeX = parseFloatInRange(patch.glitchShapeRightEyeX, runtimeConfig.glitchShapeRightEyeX, 0, 60);
  }
  if (patch.glitchShapeRightEyeY !== undefined) {
    runtimeConfig.glitchShapeRightEyeY = parseFloatInRange(patch.glitchShapeRightEyeY, runtimeConfig.glitchShapeRightEyeY, -10, 40);
  }
  if (patch.glitchShapeRightEyeW !== undefined) {
    runtimeConfig.glitchShapeRightEyeW = parseFloatInRange(patch.glitchShapeRightEyeW, runtimeConfig.glitchShapeRightEyeW, 1, 30);
  }
  if (patch.glitchShapeRightEyeH !== undefined) {
    runtimeConfig.glitchShapeRightEyeH = parseFloatInRange(patch.glitchShapeRightEyeH, runtimeConfig.glitchShapeRightEyeH, 1, 40);
  }
  if (patch.glitchShapeRightEyeRx !== undefined) {
    runtimeConfig.glitchShapeRightEyeRx = parseFloatInRange(patch.glitchShapeRightEyeRx, runtimeConfig.glitchShapeRightEyeRx, 0, 15);
  }
  if (patch.glitchShapeRightEyeRy !== undefined) {
    runtimeConfig.glitchShapeRightEyeRy = parseFloatInRange(patch.glitchShapeRightEyeRy, runtimeConfig.glitchShapeRightEyeRy, 0, 15);
  }
  if (patch.glitchShapeMouthX !== undefined) {
    runtimeConfig.glitchShapeMouthX = parseFloatInRange(patch.glitchShapeMouthX, runtimeConfig.glitchShapeMouthX, 0, 60);
  }
  if (patch.glitchShapeMouthY !== undefined) {
    runtimeConfig.glitchShapeMouthY = parseFloatInRange(patch.glitchShapeMouthY, runtimeConfig.glitchShapeMouthY, 0, 40);
  }
  if (patch.glitchShapeMouthW !== undefined) {
    runtimeConfig.glitchShapeMouthW = parseFloatInRange(patch.glitchShapeMouthW, runtimeConfig.glitchShapeMouthW, 1, 30);
  }
  if (patch.glitchShapeMouthH !== undefined) {
    runtimeConfig.glitchShapeMouthH = parseFloatInRange(patch.glitchShapeMouthH, runtimeConfig.glitchShapeMouthH, 1, 20);
  }
  if (patch.glitchShapeMouthRx !== undefined) {
    runtimeConfig.glitchShapeMouthRx = parseFloatInRange(patch.glitchShapeMouthRx, runtimeConfig.glitchShapeMouthRx, 0, 15);
  }
  if (patch.glitchShapeMouthRy !== undefined) {
    runtimeConfig.glitchShapeMouthRy = parseFloatInRange(patch.glitchShapeMouthRy, runtimeConfig.glitchShapeMouthRy, 0, 15);
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

function normalizeExpressionProfiles(
  value: unknown,
  fallback: ExpressionProfileMap,
): ExpressionProfileMap {
  if (typeof value !== 'object' || value === null) {
    return structuredClone(fallback);
  }

  const next = structuredClone(fallback);
  const input = value as Record<string, unknown>;
  for (const name of Object.keys(DEFAULT_EXPRESSION_PROFILES) as ExpressionName[]) {
    if (!(name in input)) {
      continue;
    }
    next[name] = normalizeExpressionProfile(input[name], fallback[name], name);
  }
  return next;
}

function normalizeExpressionProfile(
  value: unknown,
  fallback: ExpressionProfile | null,
  name: ExpressionName,
): ExpressionProfile | null {
  if (value == null) {
    return name === 'idle' ? null : {};
  }
  if (typeof value !== 'object') {
    return fallback;
  }

  const input = value as Record<string, unknown>;
  const next: ExpressionProfile = {};
  if (input.eyeH !== undefined) next.eyeH = parseFloatInRange(input.eyeH, fallback?.eyeH ?? 1, 0.05, 2);
  if (input.eyeW !== undefined) next.eyeW = parseFloatInRange(input.eyeW, fallback?.eyeW ?? 1, 0.3, 2);
  if (input.eyeDy !== undefined) next.eyeDy = parseFloatInRange(input.eyeDy, fallback?.eyeDy ?? 0, -10, 15);
  if (input.eyeSkew !== undefined) next.eyeSkew = parseFloatInRange(input.eyeSkew, fallback?.eyeSkew ?? 0, -0.5, 0.5);
  if (input.mouthW !== undefined) next.mouthW = parseFloatInRange(input.mouthW, fallback?.mouthW ?? 1, 0.1, 2);
  if (input.mouthH !== undefined) next.mouthH = parseFloatInRange(input.mouthH, fallback?.mouthH ?? 1, 0.1, 4);
  if (input.mouthRound !== undefined) next.mouthRound = Boolean(input.mouthRound);
  if (input.tears !== undefined) next.tears = Boolean(input.tears);
  if (input.eyeShape === 'rect' || input.eyeShape === 'heart') next.eyeShape = input.eyeShape;
  if (
    input.mouthShape === 'rect' ||
    input.mouthShape === 'frown' ||
    input.mouthShape === 'smile-arc' ||
    input.mouthShape === 'round'
  ) {
    next.mouthShape = input.mouthShape;
  }
  if (input.colorHex !== undefined) next.colorHex = normalizeHexColor(input.colorHex, fallback?.colorHex ?? '#a855f7');
  if (input.tearColorHex !== undefined) next.tearColorHex = normalizeHexColor(input.tearColorHex, fallback?.tearColorHex ?? '#57bfff');

  if (!Object.keys(next).length) {
    return name === 'idle' ? null : {};
  }
  return next;
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
