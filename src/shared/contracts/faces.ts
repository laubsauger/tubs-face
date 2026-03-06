export type FaceEmbedding = number[];
export type FaceBox = [number, number, number, number];
export type FaceLandmarks = Array<[number, number]>;

export interface EnrolledFace {
  id: string;
  name: string;
  embedding: FaceEmbedding;
  createdAt?: number;
  thumbnail?: string;
}

export interface FaceLibraryDocument {
  faces: EnrolledFace[];
}

export interface RecognitionMatch {
  id?: string;
  name?: string;
  score: number;
}

export interface DetectedFace {
  box: FaceBox;
  score: number;
  confidence?: number;
  landmarks?: FaceLandmarks | null;
  embedding?: FaceEmbedding | null;
  name?: string | null;
  match?: RecognitionMatch | null;
  matches?: RecognitionMatch[];
  _trackedAge?: number;
}

export interface AppearanceFrame {
  data: string;
  ts: number;
  faces: string[];
  count: number;
}

export interface FaceSnapshotPacket {
  faces: DetectedFace[];
  inferenceMs: number;
  ts: number;
  embeddingsExtracted: number;
  embeddingsReused: number;
}

export interface GreetingSet {
  unnamed: string[];
  named: string[];
}

export interface GreetingsConfig {
  maxWords: number;
  triggers: string[];
  responses: string[];
  wake: GreetingSet;
  join: GreetingSet;
  departure: GreetingSet;
}
