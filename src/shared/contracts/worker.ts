import type { DetectedFace } from './faces.js';

export type FaceWorkerStage = 'init' | 'diag' | 'Detection model' | 'Recognition model' | string;

export interface FaceWorkerInitRequest {
  type: 'init';
}

export interface FaceWorkerDetectRequest {
  type: 'detect';
  imageBuffer: ArrayBuffer;
  width: number;
  height: number;
  requestId?: string;
}

export type FaceWorkerRequestMessage =
  | FaceWorkerInitRequest
  | FaceWorkerDetectRequest;

export interface FaceWorkerReadyMessage {
  type: 'ready';
}

export interface FaceWorkerProgressMessage {
  type: 'progress';
  stage: FaceWorkerStage;
  detail: string;
}

export interface FaceWorkerFacesMessage {
  type: 'faces';
  faces: DetectedFace[];
  inferenceMs: number;
  embeddingsExtracted: number;
  embeddingsReused: number;
  stageTimings?: {
    detectMs: number;
    embedMs: number;
    totalMs: number;
  };
  requestId?: string;
}

export interface FaceWorkerErrorMessage {
  type: 'error';
  message: string;
  requestId?: string;
}

export type FaceWorkerResponseMessage =
  | FaceWorkerReadyMessage
  | FaceWorkerProgressMessage
  | FaceWorkerFacesMessage
  | FaceWorkerErrorMessage;
