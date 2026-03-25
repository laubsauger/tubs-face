import type { GreetingsConfig, EnrolledFace, FaceLibraryDocument } from './faces.js';
import type { RuntimeConfig, SessionStats } from './config.js';
import type { TurnBeat, TurnDonation } from './turn-script.js';
import type { DonationSignalPayload } from './ws.js';

export interface HealthResponse {
  status: 'ok';
  clients?: number;
  uptime?: number;
  processingMode?: string;
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

export interface IgnoredResponse extends OkResponse {
  ignored: true;
  reason: string;
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
  donation?: TurnDonation | null;
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

export interface VoicePreviewRequest {
  text?: string;
  finalized?: boolean;
}

export interface VoicePreviewResponse extends OkResponse {
  text?: string;
  shouldReply?: boolean;
}

export interface VoiceSegmentRequest {
  text?: string;
  finalized?: boolean;
}

export interface VoiceSegmentResponse extends OkResponse {
  text?: string;
  turnId?: string;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  actor?: 'main' | 'small';
  stream?: boolean;
  chunkIndex?: number;
  turnId?: string;
}

export interface TtsResponseMetadata {
  ok: true;
  mimeType?: string;
  durationMs?: number;
  voice?: string;
}

export interface PayPalOrderRequest {
  amount?: string;
  currency?: string;
  description?: string;
  referenceId?: string;
}

export interface PayPalOrderResponse extends OkResponse {
  id?: string;
  status?: string;
  orderId?: string;
  approveUrl?: string;
  order?: unknown;
}

export interface PayPalCaptureRequest {
  orderId: string;
}

export interface PayPalCaptureResponse extends OkResponse {
  id?: string;
  status?: string;
  capture?: unknown;
  donationSignal?: DonationSignalPayload | null;
}

export interface DonationConfirmRequest {
  source?: string;
  certainty?: 'implied' | 'confident';
  amount?: string;
  message?: string;
  currency?: string;
  note?: string;
  donor?: string;
  reference?: string;
}

export interface DonationConfirmResponse extends OkResponse {
  signal?: DonationSignalPayload;
}

export interface FaceCreateRequest {
  name: string;
  embedding: number[];
}

export type FacesListResponse = EnrolledFace[];

export interface FaceCreateResponse extends OkResponse {
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
