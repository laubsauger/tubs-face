import type {
  DonationSignalCertainty,
  ExpressionName,
  RuntimeConfig,
  SessionStats,
} from './config.js';
import type { AppearanceFrame } from './faces.js';
import type { EmotionImpulse, TurnContextMeta, TurnDonation, TurnScript } from './turn-script.js';

export interface TokenUsage {
  in: number;
  out: number;
}

export interface TotalsUsage {
  in: number;
  out: number;
  cost: number;
}

export interface DonationSignalPayload {
  certainty: DonationSignalCertainty;
  source?: string;
  amount?: string;
  currency?: string;
  donor?: string;
  note?: string;
  reference?: string;
  ts?: number;
}

export interface SpeechEmotionPayload {
  emoji?: string | null;
  expression?: ExpressionName | null;
  impulse?: EmotionImpulse | null;
}

export interface WsPingClientMessage {
  type: 'ping';
  ts: number;
}

export interface WsIncomingClientMessage {
  type: 'incoming';
  text: string;
  frame?: string | null;
}

export interface WsInterruptClientMessage {
  type: 'interrupt';
  turnId?: string;
}

export interface WsFaceMotionClientMessage {
  type: 'face_motion';
  actor: 'main' | 'small';
  x: number;
  y: number;
  ts?: number;
}

export interface WsFaceBlinkClientMessage {
  type: 'face_blink';
  actor: 'main' | 'small';
  ts?: number;
}

export interface WsHeadSpeechStateClientMessage {
  type: 'head_speech_state';
  actor: 'main' | 'small';
  state: 'start' | 'end';
  turnId?: string | null;
  ts?: number;
  durationMs?: number;
}

export interface WsPresenceClientMessage {
  type: 'presence';
  present: boolean;
  faces?: string[];
  count?: number;
}

export interface WsFaceGreetingClientMessage {
  type: 'face_greeting';
}

export interface WsProactiveClientMessage {
  type: 'proactive';
  context?: string;
  faces?: string[];
}

export interface WsCameraFrameClientMessage {
  type: 'camera_frame';
  frame: string;
}

export interface WsAppearanceFrameClientMessage {
  type: 'appearance_frame';
  frame: string;
  faces?: string[];
  count?: number;
}

export type WsClientMessage =
  | WsPingClientMessage
  | WsIncomingClientMessage
  | WsInterruptClientMessage
  | WsFaceMotionClientMessage
  | WsFaceBlinkClientMessage
  | WsHeadSpeechStateClientMessage
  | WsPresenceClientMessage
  | WsFaceGreetingClientMessage
  | WsProactiveClientMessage
  | WsCameraFrameClientMessage
  | WsAppearanceFrameClientMessage;

export interface WsPingServerMessage {
  type: 'ping';
  ts: number;
  serverTs: number;
}

export interface WsConfigServerMessage extends RuntimeConfig {
  type: 'config';
}

export interface WsSystemServerMessage {
  type: 'system';
  text: string;
}

export interface WsExpressionServerMessage {
  type: 'expression';
  expression: ExpressionName;
}

export interface WsThinkingServerMessage {
  type: 'thinking';
}

export interface WsSpeakServerMessage {
  type: 'speak';
  text: string;
  ts: number;
  donation?: TurnDonation | null;
  emotion?: SpeechEmotionPayload | null;
  turnId?: string | null;
}

export interface WsSpeakChunkServerMessage {
  type: 'speak_chunk';
  text: string;
  chunkIndex: number;
  turnId?: string;
}

export interface WsSpeakEndServerMessage {
  type: 'speak_end';
  turnId?: string;
  text?: string;
  emotion?: SpeechEmotionPayload | null;
  donation?: TurnDonation | null;
  fullText?: string;
}

export interface WsAudioChunkServerMessage {
  type: 'audio_chunk';
  audio: string;
  mimeType?: string;
  chunkIndex?: number;
  isFinal?: boolean;
  turnId?: string;
}

export interface WsTurnStartServerMessage {
  type: 'turn_start';
  turnId: string;
}

export interface WsTurnContextServerMessage {
  type: 'turn_context';
  turnId?: string;
  meta: TurnContextMeta;
}

export interface WsTurnScriptServerMessage extends TurnScript {
  type: 'turn_script';
}

export interface WsBackchannelServerMessage {
  type: 'backchannel';
  text: string;
}

export interface WsIncomingServerMessage {
  type: 'incoming';
  text: string;
}

export interface WsDonationSignalServerMessage extends DonationSignalPayload {
  type: 'donation_signal';
}

export interface WsStatsServerMessage {
  type: 'stats';
  tokens?: TokenUsage;
  totals?: TotalsUsage;
  latency?: number;
  model?: string;
  cost?: number;
  session?: SessionStats;
}

export interface WsStreamDebugServerMessage {
  type: 'stream_debug';
  stage?: string;
  detail?: string;
  turnId?: string;
  ts?: number;
}

export interface WsConversationModeServerMessage {
  type: 'conversation_mode';
  active: boolean;
  expiresIn?: number;
}

export interface WsSleepServerMessage {
  type: 'sleep';
}

export interface WsWakeServerMessage {
  type: 'wake';
}

export interface WsErrorServerMessage {
  type: 'error';
  text: string;
}

export interface WsFaceMotionServerMessage {
  type: 'face_motion';
  actor: 'main' | 'small';
  x: number;
  y: number;
  ts: number;
}

export interface WsFaceBlinkServerMessage {
  type: 'face_blink';
  actor: 'main' | 'small';
  ts: number;
}

export interface WsHeadSpeechStateServerMessage {
  type: 'head_speech_state';
  actor: 'main' | 'small';
  state: 'start' | 'end';
  turnId?: string | null;
  ts: number;
  durationMs?: number;
}

export type WsServerMessage =
  | WsPingServerMessage
  | WsConfigServerMessage
  | WsSystemServerMessage
  | WsExpressionServerMessage
  | WsThinkingServerMessage
  | WsSpeakServerMessage
  | WsSpeakChunkServerMessage
  | WsSpeakEndServerMessage
  | WsAudioChunkServerMessage
  | WsTurnStartServerMessage
  | WsTurnContextServerMessage
  | WsTurnScriptServerMessage
  | WsBackchannelServerMessage
  | WsIncomingServerMessage
  | WsDonationSignalServerMessage
  | WsStatsServerMessage
  | WsStreamDebugServerMessage
  | WsConversationModeServerMessage
  | WsSleepServerMessage
  | WsWakeServerMessage
  | WsErrorServerMessage
  | WsFaceMotionServerMessage
  | WsFaceBlinkServerMessage
  | WsHeadSpeechStateServerMessage;

export interface LatestFrameSnapshot {
  data: string;
  ts: number;
}

export type AppearanceFrameSnapshot = AppearanceFrame;
