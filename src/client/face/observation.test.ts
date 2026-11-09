import { describe, expect, it } from 'vitest';
import type { DetectedFace } from '../../shared/contracts/faces.js';
import { isFaceObservation } from '../../shared/guards/index.js';
import { observedFaces, type ObservationTracks } from './observation.js';

// The browser worker reports in the same shape the face service will
// (docs/face-service.md), so the debug view, the pulse and the recognition
// part need not know which ran. A face keeps its track while it stays in view;
// boxes are fractions of the frame; names only with a match.

const flo: DetectedFace = {
  box: [480, 135, 672, 405], score: 0.98, confidence: 0.82, name: 'Flo',
  match: { name: 'Flo', score: 0.74 },
  matches: [{ name: 'Flo', score: 0.74 }, { name: 'Tihana', score: 0.13 }, { name: 'Denali', score: 0.11 }, { name: 'Extra', score: 0.05 }],
  embedding: [0.1, 0.2],
};
const stranger: DetectedFace = { box: [100, 100, 200, 220], score: 0.7, matches: [{ name: 'Dimi', score: 0.31 }] };

describe('observedFaces', () => {
  it('keeps the shape both producers send: 0..1 boxes, at most three candidates, a name only with a match', () => {
    const tracks: ObservationTracks = { next: 1, last: [] };
    const faces = observedFaces([flo, stranger], { width: 960, height: 540 }, tracks, { onboarding: false });
    expect(faces[0]).toEqual({
      track: 1, box: [0.5, 0.25, 0.2, 0.5], score: 0.82,
      candidates: [{ name: 'Flo', sim: 0.74 }, { name: 'Tihana', sim: 0.13 }, { name: 'Denali', sim: 0.11 }],
      decision: 'match', name: 'Flo',
    });
    expect(faces[1]).toMatchObject({ track: 2, decision: 'unknown' });
    expect(faces[1]).not.toHaveProperty('name');
    expect(JSON.stringify(faces)).not.toContain('embedding');
    const observation = { t: 1, source: 'site:cam-test', frame: { w: 960, h: 540 }, faces, worker: { kind: 'browser', state: 'ready', backend: 'wasm', threads: 8, inferMs: 120, fps: 0.5, where: 'the studio listener page' } };
    expect(isFaceObservation(observation)).toBe(true);
  });

  it('keeps a face\'s track while it stays in view, and gives a new face a new one', () => {
    const tracks: ObservationTracks = { next: 1, last: [] };
    observedFaces([flo], { width: 960, height: 540 }, tracks, { onboarding: false });
    const moved = { ...flo, box: [490, 140, 680, 410] as [number, number, number, number] };
    const next = observedFaces([stranger, moved], { width: 960, height: 540 }, tracks, { onboarding: true });
    expect(next.map((face) => face.track)).toEqual([2, 1]);
    // Unknown while auto onboarding collects shots: being onboarded.
    expect(next[0]!.decision).toBe('onboarding');
  });
});
