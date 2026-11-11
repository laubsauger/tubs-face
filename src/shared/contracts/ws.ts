import type {
  ExpressionName,
  RuntimeConfig,
  SessionStats,
} from './config.js';
import type { EmotionImpulse, TurnContextMeta, TurnScript } from './turn-script.js';
import type { StudioActor, StudioCadence, StudioDevices, StudioFaceMethod, StudioFaceWorkerStatus, StudioGaze, FaceObservation, FaceRecognizer, StudioLiveStatus, StudioMicStatus, StudioMood, StudioPulse } from './studio.js';

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
  /** The gallery tour while it runs: where, the step, and the picture up on screen there (sentient-studio contract §6). */
  tour?: { where: string; step: string; stop: number; of: number; next: string | null; piece?: { title: string; date?: string; by?: string; text?: string; img?: string } };
  /** The gallery night: what hangs where, in detail at the windows the heads are at. */
  gallery?: { showing: Array<{ where: string; here?: boolean; pictures: Array<{ title: string; at?: 'left' | 'middle' | 'right'; cut?: boolean; date?: string; by?: string; text?: string; img?: string }> }> };
  /**
   * Additive: how the scene listens. wake: answer only speech that calls the heads ("hey Tubs", or one of
   * `names`); false: answer everything heard. A change sets the studio's wake-word switch (studio/listen.ts).
   */
  listen?: { wake: boolean; names?: string[] };
  /** The screening while it runs: the film on every screen and the shot up now; host while the heads comment on it at `where` (sentient-studio contract §8). */
  screening?: { film: string; about?: string; cast?: string; host: boolean; where?: string | null; shot: { title: string; date?: string; text?: string }; n: number; of: number };
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
  /** Listener page only: this box's input devices, for GET /studio/sources. */
  devices?: StudioDevices;
  /** Listener page only: its face worker (GET /studio/vision, the pulse, parts). */
  faceWorker?: StudioFaceWorkerStatus;
}

/**
 * Studio listener page: what it hears and sees, at most ~10 Hz; the server
 * relays it to the dashboards (studio_live). speaking: either head is talking.
 */
export interface WsStudioLiveClientMessage {
  type: 'studio_live';
  actor: StudioActor;
  status: StudioLiveStatus | null;
  speaking: boolean;
  /** Its face worker, for the face debug view. */
  faceWorker?: StudioFaceWorkerStatus;
}

/** Dashboard: it shows the studio listener's live state (live) and its camera (video); both false when it stops. */
export interface WsStudioWatchClientMessage {
  type: 'studio_watch';
  live: boolean;
  video: boolean;
}

/** Studio listener: a small JPEG of its camera, a few a second, only while a dashboard watches the video. */
export interface WsStudioFrameClientMessage {
  type: 'studio_frame';
  actor: StudioActor;
  frame: string;
  width: number;
  height: number;
}

/** Dashboard: run this on the studio listener's face runtime (onboarding with its camera); answered by studio_face_result. */
export interface WsStudioFaceCallClientMessage {
  type: 'studio_face_call';
  id: string;
  method: StudioFaceMethod;
  args?: Record<string, unknown>;
}

/** Studio listener: the answer to a studio_face_call. */
export interface WsStudioFaceResultClientMessage {
  type: 'studio_face_result';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
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
  | WsStudioLiveClientMessage
  | WsStudioWatchClientMessage
  | WsStudioFrameClientMessage
  | WsStudioFaceCallClientMessage
  | WsStudioFaceResultClientMessage
  | WsStudioCaptionClientMessage
  | WsStudioContextClientMessage
  | WsStudioStageClientMessage
  | WsFaceObservationClientMessage;

/**
 * The listener page's browser worker reports a frame's faces in the same shape
 * the face service does (docs/face-service.md); the server passes it on to the
 * dashboards. Studio listener page (main) only.
 */
export interface WsFaceObservationClientMessage {
  type: 'face_observation';
  observation: FaceObservation;
}

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
  /**
   * Two-head: the other head's line this one answers. In studio mode it is sent
   * ahead, and the face page starts it a breath after that line's caption says
   * it has played out.
   */
  after?: { actor: 'main' | 'small'; text: string };
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
  /** The listener's switches (absent: all on, from an older server). Descriptions and relationships are config. */
  switches?: { camera: boolean; faceRecognition: boolean; mic: boolean };
  /** Studio face pages only: the Authorization headers for the site node (TUBS_STUDIO_SITE_AUTH). */
  siteAuth?: { publish?: string; read?: string };
  /**
   * Who recognises faces (docs/face-service.md). 'service': the listener page
   * starts no face worker and takes the server's face_observation instead.
   * Absent: 'browser', as before.
   */
  faces?: FaceRecognizer;
}

/**
 * One frame's faces (docs/face-service.md), from whichever producer runs: to
 * the listener page while the face service recognises (its sleep and proactive
 * lines follow who is in view), and to dashboards that watch the studio.
 */
export interface WsFaceObservationServerMessage {
  type: 'face_observation';
  observation: FaceObservation;
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
  | WsStudioStateServerMessage
  | WsStudioWatchServerMessage
  | WsStudioFaceCallServerMessage
  | WsFaceObservationServerMessage;

/** The studio listener's live state, relayed to dashboards on the local network while studio mode is on. */
/**
 * Studio: on the gallery tour the heads decided to lead the group on now (their reply carried
 * "lead": "next"); the director (sentient-studio contract §8) moves the tour on: to the picture while
 * they gather, else on to the next stop. Additive.
 */
export interface WsStudioLeadServerMessage {
  type: 'studio_lead';
  to: 'next';
  ts: number;
}

export interface WsStudioLiveServerMessage {
  type: 'studio_live';
  actor: StudioActor;
  status: StudioLiveStatus | null;
  speaking: boolean;
  faceWorker?: StudioFaceWorkerStatus;
}

/** To the studio listener: whether anyone watches its live state and its camera (it sends nothing otherwise). */
export interface WsStudioWatchServerMessage {
  type: 'studio_watch';
  live: boolean;
  video: boolean;
}

/** The studio listener's camera, to the dashboards that watch it. */
export interface WsStudioFrameServerMessage {
  type: 'studio_frame';
  actor: StudioActor;
  frame: string;
  width: number;
  height: number;
}

/** GET /studio/pulse, pushed to the dashboards that watch. */
export interface WsStudioPulseServerMessage {
  type: 'studio_pulse';
  pulse: StudioPulse;
}

/** A dashboard's studio_face_call, forwarded to the studio listener. */
export interface WsStudioFaceCallServerMessage {
  type: 'studio_face_call';
  id: string;
  method: StudioFaceMethod;
  args?: Record<string, unknown>;
}

/** The listener's answer, back to the dashboard that asked. */
export interface WsStudioFaceResultServerMessage {
  type: 'studio_face_result';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** A voice is rendering (Ming or Kokoro): the face window holds its checks meanwhile. */
export interface WsTtsRenderingServerMessage {
  type: 'tts_rendering';
  rendering: boolean;
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
  | WsFacesChangedServerMessage
  | WsSleepServerMessage
  | WsWakeServerMessage
  | WsErrorServerMessage
  | WsFaceMotionServerMessage
  | WsFaceBlinkServerMessage
  | WsHeadSpeechStateServerMessage
  | WsStudioServerMessage
  | WsTtsRenderingServerMessage
  | WsStudioLeadServerMessage
  | WsStudioLiveServerMessage
  | WsStudioWatchServerMessage
  | WsStudioFrameServerMessage
  | WsStudioPulseServerMessage
  | WsStudioFaceCallServerMessage
  | WsStudioFaceResultServerMessage;
