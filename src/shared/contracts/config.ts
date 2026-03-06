export const PROCESSING_MODES = ['legacy', 'realtime'] as const;
export const DONATION_SIGNAL_MODES = ['both', 'implied', 'confident', 'off'] as const;
export const FACE_RENDER_MODES = ['css', 'svg', 'glitch'] as const;
export const GLITCH_RENDERERS = ['auto', 'webgpu', 'canvas2d'] as const;
export const RENDER_QUALITIES = ['high', 'balanced', 'low'] as const;
export const TTS_BACKENDS = ['kokoro', 'system', 'vibevoice'] as const;
export const STT_BACKENDS = ['mlx', 'faster-whisper'] as const;
export const DUAL_HEAD_MODES = ['off', 'llm_directed', 'mirror'] as const;
export const DUAL_HEAD_TURN_POLICIES = ['llm_order', 'main_first', 'small_first'] as const;
export const CHAT_VERBOSITIES = ['all', 'user-only', 'assistant-only', 'system-only'] as const;
export const DONATION_SIGNAL_CERTAINTIES = ['implied', 'confident'] as const;
export const DONATION_SIGNAL_KINDS = ['confirmed', 'pledge'] as const;
export const EXPRESSIONS = [
  'idle',
  'idle-flat',
  'listening',
  'thinking',
  'speaking',
  'smile',
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
] as const;

export type ProcessingMode = (typeof PROCESSING_MODES)[number];
export type DonationSignalMode = (typeof DONATION_SIGNAL_MODES)[number];
export type FaceRenderMode = (typeof FACE_RENDER_MODES)[number];
export type GlitchRenderer = (typeof GLITCH_RENDERERS)[number];
export type RenderQuality = (typeof RENDER_QUALITIES)[number];
export type TtsBackend = (typeof TTS_BACKENDS)[number];
export type SttBackend = (typeof STT_BACKENDS)[number];
export type DualHeadMode = (typeof DUAL_HEAD_MODES)[number];
export type DualHeadTurnPolicy = (typeof DUAL_HEAD_TURN_POLICIES)[number];
export type ChatVerbosity = (typeof CHAT_VERBOSITIES)[number];
export type DonationSignalCertainty = (typeof DONATION_SIGNAL_CERTAINTIES)[number];
export type DonationSignalKind = (typeof DONATION_SIGNAL_KINDS)[number];
export type ExpressionName = (typeof EXPRESSIONS)[number];
export type EmotionCue = (typeof EMOTION_CUES)[number];
export type KokoroVoice = (typeof KOKORO_VOICES)[number];

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
  processingMode: ProcessingMode;
  sleepTimeout: number;
  model: string;
  prompt: string;
  sttModel: string;
  llmModel: string;
  llmMaxOutputTokens: number;
  donationSignalMode: DonationSignalMode;
  minFaceBoxAreaRatio: number;
  faceRenderMode: FaceRenderMode;
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
  ambientAudioEnabled: boolean;
  glitchFxEnabled: boolean;
  glitchFxBaseColor: `#${string}`;
  glitchRenderer: GlitchRenderer;
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
}

export interface ClientStateSnapshot {
  connected: boolean;
  sleeping: boolean;
  speaking: boolean;
  speakingEndedAt: number;
  recording: boolean;
  inConversation: boolean;
  expression: ExpressionName;
  turns: number;
  totalMessages: number;
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  wakeTime: number;
  sleepTimeout: number;
  lastActivity: number;
  model: string;
  cameraActive: boolean;
  faceWorkerReady: boolean;
  facesDetected: number;
  personsPresent: string[];
  presenceDetected: boolean;
  lastDonationSignalAt: number;
  donationSignalMode: DonationSignalMode;
  minFaceBoxAreaRatio: number;
  faceRenderMode: FaceRenderMode;
  renderQuality: RenderQuality;
  ttsBackend: TtsBackend;
  glitchFxEnabled: boolean;
  glitchFxBaseColor: `#${string}`;
  glitchRenderer: GlitchRenderer;
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
  chatVerbosity: ChatVerbosity;
  kokoroVoice: KokoroVoice;
  secondaryVoice: KokoroVoice;
  secondaryRenderQuality: RenderQuality;
  secondaryAudioGain: number;
  secondarySubtitleEnabled: boolean;
  dualHeadEnabled: boolean;
  dualHeadMode: DualHeadMode;
  dualHeadTurnPolicy: DualHeadTurnPolicy;
  muted: boolean;
  ambientAudioEnabled: boolean;
  enrolling: boolean;
  vadNoiseGate: number;
  currentTurnId: string | null;
  editorMode: boolean;
}
