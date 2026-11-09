import type { GreetingsConfig, EnrolledFace, FaceLibraryDocument } from './faces.js';
import type { RuntimeConfig, SessionStats } from './config.js';
import type { TurnBeat } from './turn-script.js';

export interface HealthResponse {
  status: 'ok';
  clients?: number;
  uptime?: number;
  service?: string;
  mode?: string;
  /** Every needed part is up (server/health/readiness.ts); GET /healthz answers 200 only then. */
  ready?: boolean;
  parts?: HealthParts;
}

/** up; starting (running, still loading); down; off (not needed now). */
export type PartState = 'up' | 'starting' | 'down' | 'off';

export interface HealthParts {
  node: { state: PartState };
  /** The Python speech service: speech-to-text and the TTS stream (Ming voices go through it). */
  speech: { state: PartState };
  /** Ming, needed only when a head speaks with a ming: voice. */
  ming: { state: PartState; needed: boolean };
  /** Studio mode: both face pages publishing. */
  studio: { state: PartState; actors?: Array<{ id: string; publishing: boolean; error?: string }> };
}

export interface StatsResponse extends SessionStats {
  /** Vision on its own (docs/vision.md): it is one of the main running costs. */
  vision?: VisionStats;
}

export interface VisionProviderStats {
  calls: number;
  failures: number;
  avgLatencyMs: number | null;
  lastLatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  /** Estimated: GEMINI_*_COST_PER_MTOKENS for gemini, VISION_*_COST_PER_MTOKENS for openai (local servers: 0). */
  costUsd: number;
}

export interface VisionStats extends VisionProviderStats {
  provider: string;
  model: string;
  /** The base URL the last openai call went to (fleet:vision resolves to one). */
  baseUrl: string | null;
  /** Pictures not sent, by reason. */
  skipped: { off: number; asleep: number; cap: number };
  usedThisHour: number;
  maxPerHour: number;
  lastDescriptionAt: number | null;
  byProvider: Record<'gemini' | 'openai', VisionProviderStats>;
}

export interface ConfigResponse extends RuntimeConfig {}

export interface ErrorResponse {
  error: string;
}

export interface OkResponse {
  ok: true;
}

export interface SpeakRequest {
  text: string;
}

export interface SpeakResponse extends OkResponse {
  ignored?: boolean;
  reason?: string;
}

export interface IncomingRequest {
  text: string;
}

export interface IncomingResponse extends OkResponse {
  turnId?: string;
  ignored?: boolean;
  reason?: string;
}

export interface ManualTurnScriptRequest {
  beats?: TurnBeat[];
}

export interface ManualTurnScriptResponse extends OkResponse {
  turnId: string;
  beatCount: number;
}

export interface WakeWordResult {
  detected: boolean;
  reason?: string;
  normalized?: string;
  matchedSource?: string;
  matchedToken?: string;
  version?: string;
}

export interface VoiceResponse extends OkResponse {
  ignored?: boolean;
  reason?: string;
  text?: string;
  wake?: WakeWordResult;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  actor?: 'main' | 'small';
  stream?: boolean;
  chunkIndex?: number;
  turnId?: string;
}

export interface FaceCreateRequest {
  name: string;
  embedding: number[];
}

export interface FaceCreateResponse extends OkResponse {
  face?: EnrolledFace;
}

export interface FaceUpdateRequest {
  id: string;
  name: string;
}

export interface FaceUpdateResponse extends OkResponse {
  face?: EnrolledFace;
}

export interface FaceDeleteResponse extends OkResponse {
  removed?: boolean;
}

export type GreetingsResponse = GreetingsConfig;

export interface IngestListItem {
  name: string;
  filename: string;
  url: string;
  relPath: string;
  size?: number;
  mtimeMs?: number;
}

export interface IngestListResponse {
  files: IngestListItem[];
}

export interface IngestDoneRequest {
  relPath: string;
}

export interface IngestDoneResponse extends OkResponse {
  movedTo?: string;
}

export type FaceLibraryResponse = FaceLibraryDocument;

/** Video recordings of the face window (POST /api/recordings, /chunk, /finish, /reveal). */
export interface RecordingStartRequest {
  ext: 'mp4' | 'webm';
}

export interface RecordingStartResponse {
  file: string;
  dir: string;
}

export interface RecordingFileRequest {
  file: string;
}

export interface RecordingFinishResponse {
  file: string;
  path: string;
  /** Rewritten by ffmpeg as a plain MP4; false keeps Chrome's fragmented file. */
  remuxed: boolean;
}
