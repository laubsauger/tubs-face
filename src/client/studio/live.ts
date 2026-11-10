// What the studio listener page tells the dashboards about what it hears and
// sees (studio_live): the same app state fields the face window shares with a
// dashboard in the same browser, so the dashboard's own meters and detection
// lists show it. Sent only while someone watches, at most LIVE_REPORT_MS apart.

import type { StudioLiveStatus } from '../../shared/contracts/studio.js';
import { liveFaceOf } from '../face/overlay.js';
import type { AppState } from '../state/app-state.js';

/** About 10 Hz. */
export const LIVE_REPORT_MS = 100;
/** Unchanged, a report still goes this often (a dashboard that just opened catches up). */
export const LIVE_KEEPALIVE_MS = 2000;
/** The camera preview for a watching dashboard: a few pictures a second, this wide. */
export const PREVIEW_FRAME_MS = 333;
export const PREVIEW_MAX_PX = 320;

export function liveStatusOf(state: AppState): StudioLiveStatus {
  return {
    micReady: state.micReady,
    micDenied: state.micDenied,
    // Steps of 5 %: a meter needs no more, and a quiet room sends nothing new.
    micLevel: Math.round(Math.min(1, Math.max(0, state.micLevel)) * 20) / 20,
    recording: state.recording,
    listenState: state.listenState.slice(0, 300),
    voiceLastTranscript: state.voiceLastTranscript.slice(0, 2000),
    audioPlaying: state.audioPlaying,
    faceCameraActive: state.faceCameraActive,
    faceWorkerReady: state.faceWorkerReady,
    faceWorkerBusy: state.faceWorkerBusy,
    faceStatus: state.faceStatus.slice(0, 300),
    faceLastInferenceMs: state.faceLastInferenceMs,
    faceLastEmbeddingsExtracted: state.faceLastEmbeddingsExtracted,
    faceLastEmbeddingsReused: state.faceLastEmbeddingsReused,
    faceLastDetectedCount: state.faceLastDetectedCount,
    faceFrameWidth: state.faceFrameWidth,
    faceFrameHeight: state.faceFrameHeight,
    faceLastFaces: state.faceLastFaces.slice(0, 16).map((face) => ({
      ...liveFaceOf(face),
      // Unknown and auto-onboarding on: its shots are being collected to learn it.
      decision: (face.name ?? face.match?.name) ? 'match' : state.config?.autoEnrollEnabled ? 'onboarding' : 'unknown',
    })),
  };
}
