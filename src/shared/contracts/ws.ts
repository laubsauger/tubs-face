import type {
  ExpressionName,
  RuntimeConfig,
  SessionStats,
} from './config.js';
import type { EmotionImpulse, TurnContextMeta, TurnScript } from './turn-script.js';
import type { StudioActor, StudioCadence, StudioGaze, StudioMicStatus, StudioMood } from './studio.js';

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
    /** The first of those snapshots, a small JPEG data URL, for the memory view. */
    thumbnail?: string;
  }>;
}

export interface WsTtsRequestClientMessage {
  type: 'tts_request';
  text: string;
  voice?: string;
  turnId?: string;
  requestId?: string;
}

/** Director: where this actor looks. Overrides the face's own gaze while updates keep coming. */
export interface WsStudioLookClientMessage {
  type: 'studio_look';
  actor: StudioActor;
  gaze: StudioGaze;
}

/** Director: whether people are near this actor's window, and how many. */
export interface WsStudioPresenceClientMessage {
  type: 'studio_presence';
  actor: StudioActor;
  present: boolean;
  people?: number;
}

/** A studio face page: its actor's state, on change and once a second; the server passes it on to everyone. */
export interface WsStudioStateClientMessage {
  type: 'studio_state';
  actor: StudioActor;
  speaking: boolean;
  expr: string;
  mood: StudioMood;
  ts: number;
}

/**
 * A studio face page: the line its head is saying and how much of it has been
 * heard, on change at most 10 times a second; done once per line. The server
 * passes it on to everyone.
 */
export interface WsStudioCaptionClientMessage {
  type: 'studio_caption';
  actor: StudioActor;
  turnId: string;
  text: string;
  /** Characters of `text` heard so far. */
  spoken: number;
  done: boolean;
  ts: number;
}

/**
 * Director: where the heads are in the venue and who is around (sentient-studio
 * contract §6/§8). Rendered into the turn context in places, never numbers.
 */
export interface WsStudioContextClientMessage {
  type: 'studio_context';
  reason: string;
  heads: Record<string, { zone: string | null; window: string | null; near: boolean | null; mode: string; speaking: boolean }>;
  people: Array<{
    id: string;
    zone: string | null;
    window: string | null;
    /** From the speaking head's window (else Main's); older directors leave it out. */
    relation?: 'here' | 'same-room' | 'next-room' | 'far' | null;
    /** Metres to that window, for here and same-room. */
    distance: number | null;
    dwell: number;
    engaged: boolean;
    with: 'main' | 'small' | 'both' | null;
  }>;
  reference: { head: string; window: string } | null;
  /** Once per connection and when the night's theme changes. */
  venue?: {
    theme: string | null;
    phase: string | null;
    zones: Array<{ id: string; name: string; about: string }>;
    windows: Array<{ id: string; name: string; zone: string | null; about: string }>;
  };
  ts: number;
}

/** Director: whether a head is in place to speak (it may be travelling to a visitor's window). */
export interface WsStudioStageClientMessage {
  type: 'studio_stage';
  actor: StudioActor;
  ready: boolean;
}

/** A studio face page: whether its stream is up (and, from the listener page, the mic). For GET /studio. */
export interface WsStudioStatusClientMessage {
  type: 'studio_status';
  actor: StudioActor;
  publishing: boolean;
  error?: string;
  mic?: StudioMicStatus;
  cadence?: StudioCadence;
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
  | WsTtsRequestClientMessage
  | WsStudioLookClientMessage
  | WsStudioPresenceClientMessage
  | WsStudioStateClientMessage
  | WsStudioStatusClientMessage
  | WsStudioCaptionClientMessage
  | WsStudioContextClientMessage
  | WsStudioStageClientMessage;

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
  /** Studio: a call-out beat (TurnBeat.callout); plays without waiting for the face to be in place. */
  callout?: boolean;
  /**
   * More audio for the same text follows in the next chunk. Ming streams a
   * whole reply in several chunks; the client plays them back to back and
   * keeps one subtitle across them.
   */
  more?: boolean;
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

/** The face library changed (the memory view removed someone): pages that match faces reload it. */
export interface WsFacesChangedServerMessage {
  type: 'faces_changed';
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

/** Studio settings for the face pages: sent on connect and on every change. */
export interface WsStudioConfigServerMessage {
  type: 'studio_config';
  enabled: boolean;
  site: string;
  micSource: string;
  /** Where the listener page takes pictures from (docs/vision.md). */
  visionSource: string;
  /** Site node path per actor, e.g. { main: "tubs-main", small: "tubs-small" }. */
  streams: Record<StudioActor, string>;
}

/** The director's stage, passed on to the studio face pages: is this head in place to speak? */
export interface WsStudioStageServerMessage {
  type: 'studio_stage';
  actor: StudioActor;
  ready: boolean;
}

/** The director's look, passed on to the studio face pages. */
export interface WsStudioLookServerMessage {
  type: 'studio_look';
  actor: StudioActor;
  gaze: StudioGaze;
}

/** The director's presence, passed on to the studio face pages. */
export interface WsStudioPresenceServerMessage {
  type: 'studio_presence';
  actor: StudioActor;
  present: boolean;
  people?: number;
}

export interface WsStudioStateServerMessage {
  type: 'studio_state';
  actor: StudioActor;
  speaking: boolean;
  expr: string;
  mood: StudioMood;
  ts: number;
}

export interface WsStudioCaptionServerMessage {
  type: 'studio_caption';
  actor: StudioActor;
  turnId: string;
  text: string;
  spoken: number;
  done: boolean;
  ts: number;
}

export type WsStudioServerMessage =
  | WsStudioConfigServerMessage
  | WsStudioStageServerMessage
  | WsStudioCaptionServerMessage
  | WsStudioLookServerMessage
  | WsStudioPresenceServerMessage
  | WsStudioStateServerMessage;

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
  | WsFacesChangedServerMessage
  | WsSleepServerMessage
  | WsWakeServerMessage
  | WsErrorServerMessage
  | WsFaceMotionServerMessage
  | WsFaceBlinkServerMessage
  | WsHeadSpeechStateServerMessage
  | WsStudioServerMessage;
