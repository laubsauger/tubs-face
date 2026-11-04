import type {
  ExpressionName,
  RuntimeConfig,
  SessionStats,
} from './config.js';
import type { EmotionImpulse, TurnContextMeta, TurnScript } from './turn-script.js';

export interface TokenUsage {
  in: number;
  out: number;
}

export interface TotalsUsage {
  in: number;
  out: number;
  cost: number;
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
  /** false: nobody in view for minutes, the visitor is gone. */
  present: boolean;
  /** A different person than the last visitor just came into view. */
  newVisitor?: boolean;
  faces?: string[];
  count?: number;
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
  /** The same visitor is back after stepping away for awayMs. */
  returning?: boolean;
  awayMs?: number;
}

/** Who is in view, left to right as the camera sees them; sent when that changes. */
export interface WsPeopleClientMessage {
  type: 'people';
  people: Array<{
    /** Stable for the night; field notes are kept by it. */
    id: string;
    names: string[];
    position: 'left' | 'center' | 'right';
    /** Seen earlier tonight and gone this long. */
    awayMs?: number;
    /** Face snapshots the face page holds for auto-onboarding (unnamed people only). */
    snapshots?: number;
  }>;
}

export interface WsTtsRequestClientMessage {
  type: 'tts_request';
  text: string;
  voice?: string;
  turnId?: string;
  requestId?: string;
}

export type WsClientMessage =
  | WsPingClientMessage
  | WsIncomingClientMessage
  | WsInterruptClientMessage
  | WsFaceMotionClientMessage
  | WsFaceBlinkClientMessage
  | WsHeadSpeechStateClientMessage
  | WsPresenceClientMessage
  | WsPeopleClientMessage
  | WsProactiveClientMessage
  | WsCameraFrameClientMessage
  | WsAppearanceFrameClientMessage
  | WsTtsRequestClientMessage;

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
  actor?: 'main' | 'small';
  text?: string;
  emotion?: SpeechEmotionPayload | null;
  fullText?: string;
}

export interface WsAudioChunkServerMessage {
  type: 'audio_chunk';
  audio: string;
  text?: string;
  mimeType?: string;
  chunkIndex?: number;
  isFinal?: boolean;
  turnId?: string;
  /** Which actor this audio belongs to (for dual-head server-side TTS). */
  actor?: 'main' | 'small';
  /** Beat index within the turn script (for expression sync). */
  beatIndex?: number;
  /** How Tubs feels about this reply; sets the face while the audio plays. */
  emotion?: SpeechEmotionPayload | null;
  /** A pre-rendered filler ("Um, okay.") played while the reply is generated, not model output. */
  filler?: boolean;
}

export interface WsTurnStartServerMessage {
  type: 'turn_start';
  turnId: string;
}

export interface WsInterruptServerMessage {
  type: 'interrupt';
  turnId?: string | null;
  source?: 'user' | 'system' | 'turn_start' | 'voice_barge_in';
}

export interface WsTurnContextServerMessage {
  type: 'turn_context';
  turnId?: string;
  meta: TurnContextMeta;
}

export interface WsTurnScriptServerMessage extends TurnScript {
  type: 'turn_script';
}

export interface WsIncomingServerMessage {
  type: 'incoming';
  text: string;
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

/** Someone told Tubs their name: the face page enrolls them from its snapshots. */
export interface WsEnrollRequestServerMessage {
  type: 'enroll_request';
  personId: string;
  name: string;
}

/** Tubs's field notes on the people in front of him, for the operator. */
export interface WsFieldNotesServerMessage {
  type: 'field_notes';
  /** Left to right as the camera sees them. */
  people: Array<{ id: string; position: 'left' | 'center' | 'right'; names: string[]; returning: boolean; notes: string[] }>;
  /** Notes about the group that did not say who. */
  groupNotes: string[];
  /** Recent quotes from tonight's visitors, newest first. */
  quotes: string[];
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
  | WsInterruptServerMessage
  | WsTurnContextServerMessage
  | WsTurnScriptServerMessage
  | WsIncomingServerMessage
  | WsStatsServerMessage
  | WsConversationModeServerMessage
  | WsFieldNotesServerMessage
  | WsEnrollRequestServerMessage
  | WsSleepServerMessage
  | WsWakeServerMessage
  | WsErrorServerMessage
  | WsFaceMotionServerMessage
  | WsFaceBlinkServerMessage
  | WsHeadSpeechStateServerMessage;
