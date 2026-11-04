import type { GreetingsConfig, EnrolledFace, FaceLibraryDocument } from './faces.js';
import type { RuntimeConfig, SessionStats } from './config.js';
import type { TurnBeat } from './turn-script.js';

export interface HealthResponse {
  status: 'ok';
  clients?: number;
  uptime?: number;
  service?: string;
  mode?: string;
}

export interface StatsResponse extends SessionStats {}

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
