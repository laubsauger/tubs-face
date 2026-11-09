// What the panels show for the mic and the camera: this page's own, or in
// studio mode the studio listener's (studio_live), which has them. The
// dashboard has no devices; the operator face window lets go of its own while
// studio mode is on. Either way the same meters, detection lists and boxes.

import type { DetectedFace } from '../../shared/contracts/faces.js';
import type { AppState } from '../state/app-state.js';

export interface DeviceView {
  /** True when this is the studio listener's state, not this page's. */
  studio: boolean;
  micReady: boolean;
  micDenied: boolean;
  micLevel: number;
  recording: boolean;
  listenState: string;
  voiceLastTranscript: string;
  audioPlaying: boolean;
  faceCameraActive: boolean;
  faceWorkerReady: boolean;
  faceWorkerBusy: boolean;
  faceStatus: string;
  faceLastDetectedCount: number;
  faceFrameWidth: number | null;
  faceFrameHeight: number | null;
  faceLastFaces: DetectedFace[];
  faceLastInferenceMs: number | null;
  faceLastEmbeddingsExtracted: number;
  faceLastEmbeddingsReused: number;
}

export function deviceView(state: AppState): DeviceView {
  const live = state.studioLive?.status;
  if (live) return { ...live, studio: true };
  return {
    studio: false,
    micReady: state.micReady,
    micDenied: state.micDenied,
    micLevel: state.micLevel,
    recording: state.recording,
    listenState: state.listenState,
    voiceLastTranscript: state.voiceLastTranscript,
    audioPlaying: state.audioPlaying,
    faceCameraActive: state.faceCameraActive,
    faceWorkerReady: state.faceWorkerReady,
    faceWorkerBusy: state.faceWorkerBusy,
    faceStatus: state.faceStatus,
    faceLastDetectedCount: state.faceLastDetectedCount,
    faceFrameWidth: state.faceFrameWidth,
    faceFrameHeight: state.faceFrameHeight,
    faceLastFaces: state.faceLastFaces,
    faceLastInferenceMs: state.faceLastInferenceMs,
    faceLastEmbeddingsExtracted: state.faceLastEmbeddingsExtracted,
    faceLastEmbeddingsReused: state.faceLastEmbeddingsReused,
  };
}
