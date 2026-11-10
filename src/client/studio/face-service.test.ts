import { describe, expect, it } from 'vitest';
import type { FaceObservation } from '../../shared/contracts/studio.js';
import { browserRecognizes, faceStateOf } from './face-service.js';

// While the face service recognises, the listener page must not run its own
// worker (two recognisers greet everyone twice, and the worker downloads its
// models for nothing), yet its sleep and proactive lines still need to know
// who is in view: the server's observations fill the same state.

describe('the listener page with the face service', () => {
  it('runs its own face worker only when the server does not recognise', () => {
    expect(browserRecognizes({ enabled: true, faces: 'service' })).toBe(false);
    expect(browserRecognizes({ enabled: true })).toBe(true);
    expect(browserRecognizes({ enabled: true, faces: 'browser' })).toBe(true);
    // Studio mode off: the page is not the studio's listener any more.
    expect(browserRecognizes({ enabled: false, faces: 'service' })).toBe(true);
  });

  it('takes an observation as the face runtime state: pixel boxes, the match, who is in view', () => {
    const observation: FaceObservation = {
      t: 1,
      source: 'site:cam-1',
      frame: { w: 960, h: 540 },
      faces: [
        { track: 1, box: [0.1, 0.2, 0.2, 0.5], score: 0.9, candidates: [{ name: 'Flo', sim: 0.82 }], decision: 'match', name: 'Flo' },
        { track: 2, box: [0.5, 0.2, 0.1, 0.2], score: 0.8, candidates: [{ name: 'Flo', sim: 0.12 }], decision: 'unknown' },
      ],
      worker: { kind: 'service', state: 'ready', backend: 'CoreML', inferMs: 41.6, fps: 5, where: 'studio-mac:3004' },
    };
    const state = faceStateOf(observation);
    expect(state).toMatchObject({ faceCameraActive: true, faceWorkerReady: true, faceLastDetectedCount: 2, faceFrameWidth: 960, faceFrameHeight: 540, faceLastInferenceMs: 42 });
    expect(state.faceLastFaces[0]!.box.map(Math.round)).toEqual([96, 108, 288, 378]);
    expect(state.faceLastFaces[0]).toMatchObject({ name: 'Flo', match: { name: 'Flo', score: 0.82 } });
    // An unknown face keeps its candidates for the People tab, but no name.
    expect(state.faceLastFaces[1]).toMatchObject({ name: null, match: null, matches: [{ name: 'Flo', score: 0.12 }] });
    expect(faceStateOf({ ...observation, faces: [], worker: { ...observation.worker, state: 'error', error: 'camera: 404 Not Found' } }))
      .toMatchObject({ faceWorkerReady: false, faceLastDetectedCount: 0, faceStatus: 'Face service error: camera: 404 Not Found' });
  });
});
