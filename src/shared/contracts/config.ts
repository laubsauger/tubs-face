export const RENDER_QUALITIES = ['high', 'balanced', 'low'] as const;
export const TTS_BACKENDS = ['kokoro', 'system'] as const;
export const STT_BACKENDS = ['mlx', 'faster-whisper'] as const;
export const DUAL_HEAD_MODES = ['off', 'llm_directed'] as const;
export const DUAL_HEAD_TURN_POLICIES = ['llm_order', 'main_first', 'small_first'] as const;
export const VAD_MODELS = ['rms', 'ten-vad'] as const;
export const CHAT_VERBOSITIES = ['all', 'user-only', 'assistant-only', 'system-only'] as const;
export const EXPRESSIONS = [
  'idle',
  'idle-flat',
  'listening',
  'thinking',
  'speaking',
  'smile',
  'smug',
  'happy',
  'love',
  'sad',
  'crying',
  'sleep',
  'angry',
  'surprised',
] as const;
export const EMOTION_CUES = ['🙂', '😄', '😏', '🥺', '😢', '😤', '🤖', '🫶'] as const;
export const KOKORO_VOICES = [
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
  // Not Kokoro: cloned voices served by the separate Ming service (MING_TTS_URL).
  // friend is main Tubs; friend-b (and the other take, friend-b-alt) is Mini.
  'ming:friend',
  'ming:friend-b',
  'ming:friend-b-alt',
] as const;

export type RenderQuality = (typeof RENDER_QUALITIES)[number];
export type TtsBackend = (typeof TTS_BACKENDS)[number];
export type SttBackend = (typeof STT_BACKENDS)[number];
export type DualHeadMode = (typeof DUAL_HEAD_MODES)[number];
export type DualHeadTurnPolicy = (typeof DUAL_HEAD_TURN_POLICIES)[number];
export type VadModel = (typeof VAD_MODELS)[number];
export type ChatVerbosity = (typeof CHAT_VERBOSITIES)[number];
export type ExpressionName = (typeof EXPRESSIONS)[number];
export type EmotionCue = (typeof EMOTION_CUES)[number];
export type KokoroVoice = (typeof KOKORO_VOICES)[number];

export interface ExpressionProfile {
  eyeH?: number;
  eyeW?: number;
  eyeDy?: number;
  eyeSkew?: number;
  mouthW?: number;
  mouthH?: number;
  mouthRound?: boolean;
  mouthShape?: 'rect' | 'frown' | 'smile-arc' | 'round';
  eyeShape?: 'rect' | 'heart';
  tears?: boolean;
  colorHex?: `#${string}`;
  tearColorHex?: `#${string}`;
}

export type ExpressionProfileMap = Record<ExpressionName, ExpressionProfile | null>;

export const DEFAULT_EXPRESSION_PROFILES: ExpressionProfileMap = {
  idle: null,
  'idle-flat': { mouthH: 0.65 },
  listening: { eyeH: 1.09, eyeW: 1.07 },
  thinking: { eyeH: 0.5, eyeW: 1.15, eyeDy: 5, mouthW: 0.56, mouthH: 1.4, mouthRound: true },
  smile: { eyeH: 0.85, eyeDy: 2, mouthW: 0.85, mouthH: 1.8 },
  // Half-lidded and a small smirk: Tubs's resting attitude.
  smug: { eyeH: 0.55, eyeDy: 4, eyeW: 1.08, mouthW: 0.62, mouthH: 1.3, mouthShape: 'smile-arc' },
  happy: { eyeH: 0.7, eyeDy: 2, mouthW: 0.95, mouthH: 2.1, mouthShape: 'smile-arc' },
  love: { eyeH: 0.85, eyeDy: 1, mouthW: 0.9, mouthH: 1.5, eyeShape: 'heart', colorHex: '#ff4da1', mouthShape: 'smile-arc' },
  sad: { eyeH: 0.3, eyeDy: 7, eyeW: 1.15, mouthW: 0.56, mouthH: 0.7, mouthShape: 'frown' },
  crying: { eyeH: 0.3, eyeDy: 7, eyeW: 1.15, mouthW: 0.56, mouthH: 0.7, mouthShape: 'frown', tears: true, tearColorHex: '#57bfff' },
  speaking: null,
  sleep: { eyeH: 0.12, eyeDy: 8, mouthW: 0.8, mouthH: 0.5 },
  angry: { eyeH: 0.45, eyeW: 1.2, eyeDy: 4, eyeSkew: -0.15 },
  surprised: { eyeH: 1.15, eyeW: 1.1, mouthW: 0.56, mouthH: 2.2, mouthRound: true, mouthShape: 'round' },
};

export interface SessionStats {
  messagesIn: number;
  messagesOut: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  uptime: number;
  lastActivity: number | null;
  model: string;
}

export interface RuntimeConfig {
  sleepTimeout: number;
  model: string;
  prompt: string;
  sttModel: string;
  llmModel: string;
  llmMaxOutputTokens: number;
  renderQuality: RenderQuality;
  ttsBackend: TtsBackend;
  sttBackend: SttBackend;
  kokoroVoice: KokoroVoice;
  dualHeadEnabled: boolean;
  dualHeadMode: DualHeadMode;
  secondaryVoice: KokoroVoice;
  secondaryRenderQuality: RenderQuality;
  secondarySubtitleEnabled: boolean;
  secondaryAudioGain: number;
  dualHeadTurnPolicy: DualHeadTurnPolicy;
  muted: boolean;
  /**
   * Talking over Tubs or Mini cuts them off, hands-free too. Off, the mic
   * ignores speech while either head talks (with speakers it hears them).
   */
  interruptible: boolean;
  /** Quietly take face snapshots of unnamed people and enroll them when they tell Tubs their name. */
  autoEnrollEnabled: boolean;
  ambientAudioEnabled: boolean;
  glitchFxEnabled: boolean;
  glitchFxBaseColor: `#${string}`;
  glitchExpressionProfiles: ExpressionProfileMap;
  glitchPixelSize: number;
  glitchPixelGap: number;
  glitchScanlines: boolean;
  glitchScanlineIntensity: number;
  glitchScanlineSpacing: number;
  glitchScanlineThickness: number;
  glitchScanlineSpeed: number;
  glitchPixelJitter: number;
  glitchFlicker: boolean;
  glitchFlickerSpeed: number;
  glitchFlickerDepth: number;
  glitchGlowStrength: number;
  glitchColorHueVariation: number;
  glitchColorBrightnessVariation: number;
  glitchColorOpacityMin: number;
  glitchShapeLeftEyeX: number;
  glitchShapeLeftEyeY: number;
  glitchShapeLeftEyeW: number;
  glitchShapeLeftEyeH: number;
  glitchShapeLeftEyeRx: number;
  glitchShapeLeftEyeRy: number;
  glitchShapeRightEyeX: number;
  glitchShapeRightEyeY: number;
  glitchShapeRightEyeW: number;
  glitchShapeRightEyeH: number;
  glitchShapeRightEyeRx: number;
  glitchShapeRightEyeRy: number;
  glitchShapeMouthX: number;
  glitchShapeMouthY: number;
  glitchShapeMouthW: number;
  glitchShapeMouthH: number;
  glitchShapeMouthRx: number;
  glitchShapeMouthRy: number;
  glitchBrightnessPulseEnabled: boolean;
  glitchBrightnessPulseDim: number;
  glitchBrightnessPulseBright: number;
  glitchBrightnessPulseSpeed: number;
  glitchScanBeamEnabled: boolean;
  glitchScanBeamSpeed: number;
  glitchScanBeamLineWidth: number;
  glitchScanBeamBrightness: number;
  glitchScanBeamGlowStrength: number;
  glitchScanBeamJitter: number;
  glitchScanBeamColor: `#${string}`;
  glitchChromaticEnabled: boolean;
  glitchChromaticOffsetX: number;
  glitchChromaticOffsetY: number;
  glitchChromaticIntensity: number;
  glitchChromaticAnimate: boolean;
  glitchChromaticAnimateSpeed: number;
  glitchSliceEnabled: boolean;
  glitchSliceCount: number;
  glitchSliceMaxOffset: number;
  glitchSliceSpeed: number;
  glitchSliceIntensity: number;
  glitchSliceColorShift: number;
  glitchSliceGapChance: number;
  glitchSliceIntervalMs: number;
  glitchSliceBurstDurationMs: number;
  secondaryGlitchFxBaseColor: `#${string}`;
  ttsStreamingEnabled: boolean;
  vadNoiseGate?: number;
  vadModel?: VadModel;
}
