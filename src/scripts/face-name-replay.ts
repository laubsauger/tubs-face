// Replays face checks through the old naming (each frame on its own, margin
// 0.01) and the new one (margin MATCH_MARGIN, names settled per track,
// client/face/settle.ts), and counts how often the name on a track changes,
// how many different names a track was ever given (the people tracker keeps
// them all for the night: greetings, relationships and notes follow them), how
// many checks showed a wrong name, and how long until the right one.
//
//   npx tsx src/scripts/face-name-replay.ts [--lines <recorded.ndjson> ...]
//
// Scenarios:
//   live      the three checks from the studio on 2026-11-09 (Flo named "Rapha")
//   library   each person's library samples in time order as one track's checks,
//             each matched without its own sitting (leave-one-session-out), one
//             check every 5 s like the listener page; people with one sitting
//             are strangers to the rest of the library
//   --lines   NDJSON recorded from a clip (tests/face-compat/record_lines.py),
//             matched against Obama (2012 photo), Biden and Harris from
//             tests/fixtures/faces/browser-embeddings.json; the big face is
//             Obama (the clips show his 2009 photo), the small ones strangers
//
// Prints names and numbers only, never an embedding.

import { readFileSync } from 'node:fs';
import { acceptedMatch, annotateDetectedFaces, cosineSimilarity, MATCH_MARGIN } from '../client/face/matching.js';
import { createNameSettler } from '../client/face/settle.js';
import { groupLibrary } from '../client/face/library-sessions.js';
import { readFaceLibrary } from '../server/faces/library.js';
import type { DetectedFace, EnrolledFace, FaceBox } from '../shared/contracts/faces.js';

/** One check of one face: matched against `library`, or given as its candidates (`matches`) already. */
interface Check { track: string; at: number; truth: string | null; face: DetectedFace & { track?: number }; library: EnrolledFace[] | null }
interface TrackResult { track: string; truth: string | null; checks: number; changes: number; swaps: number; namesGiven: string[]; wrongChecks: number; rightChecks: number; firstRightAt: number | null }

const OLD_MARGIN = 0.01;

function oldVerdict(face: DetectedFace): string | null {
  return acceptedMatch(face.matches ?? [], OLD_MARGIN)?.name ?? null;
}

/** This check as annotateDetectedFaces leaves it (today's margin). */
function annotate(check: Check): DetectedFace {
  if (check.library) return annotateDetectedFaces([check.face], check.library)[0]!;
  const accepted = acceptedMatch(check.face.matches ?? []);
  return { ...check.face, name: accepted?.name ?? null, match: accepted };
}

function measure(checks: Check[], decide: 'old' | 'new'): TrackResult[] {
  const settler = createNameSettler();
  const ids = new Map<string, number>();
  const byTrack = new Map<string, { truth: string | null; shown: Array<{ at: number; name: string | null }> }>();
  for (const check of checks) {
    const annotated = annotate(check);
    // Each track its own: the producer's track number, here the scenario's track name.
    if (!ids.has(check.track)) ids.set(check.track, ids.size + 1);
    const name = decide === 'old' ? oldVerdict(annotated) : settler.settle([{ ...annotated, track: ids.get(check.track)! }], check.at)[0]!.name ?? null;
    const entry = byTrack.get(check.track) ?? { truth: check.truth, shown: [] };
    entry.shown.push({ at: check.at, name });
    byTrack.set(check.track, entry);
  }
  return [...byTrack.entries()].map(([track, { truth, shown }]) => {
    let changes = 0;
    let swaps = 0;
    for (let i = 1; i < shown.length; i += 1) {
      const before = shown[i - 1]!.name;
      const after = shown[i]!.name;
      if (before !== after) changes += 1;
      if (before && after && before !== after) swaps += 1;
    }
    const start = shown[0]!.at;
    const right = shown.find((entry) => truth !== null && entry.name === truth);
    return {
      track,
      truth,
      checks: shown.length,
      changes,
      swaps,
      namesGiven: [...new Set(shown.map((entry) => entry.name).filter((name): name is string => Boolean(name)))],
      wrongChecks: shown.filter((entry) => entry.name !== null && entry.name !== truth).length,
      rightChecks: shown.filter((entry) => truth !== null && entry.name === truth).length,
      firstRightAt: right ? right.at - start : null,
    };
  });
}

function summarize(label: string, checks: Check[]): void {
  const rows = (['old', 'new'] as const).map((decide) => {
    const tracks = measure(checks, decide);
    const named = tracks.filter((track) => track.firstRightAt !== null);
    const times = named.map((track) => track.firstRightAt!).sort((a, b) => a - b);
    return {
      naming: decide === 'old' ? `per frame, margin ${OLD_MARGIN}` : `settled per track, margin ${MATCH_MARGIN}`,
      tracks: tracks.length,
      checks: checks.length,
      'name changes': tracks.reduce((sum, track) => sum + track.changes, 0),
      'swaps (A to B)': tracks.reduce((sum, track) => sum + track.swaps, 0),
      'tracks given a wrong name': tracks.filter((track) => track.namesGiven.some((name) => name !== track.truth)).length,
      'checks showing a wrong name': tracks.reduce((sum, track) => sum + track.wrongChecks, 0),
      'checks showing the right name': tracks.reduce((sum, track) => sum + track.rightChecks, 0),
      'tracks named right': `${named.length}/${tracks.filter((track) => track.truth !== null).length}`,
      'first right name (median s)': times.length ? Math.round(times[Math.floor((times.length - 1) / 2)]! / 100) / 10 : null,
    };
  });
  console.log(`\n${label}`);
  console.table(rows);
}

function wrongDetail(checks: Check[]): void {
  const old = measure(checks, 'old').filter((track) => track.namesGiven.some((name) => name !== track.truth));
  const now = new Map(measure(checks, 'new').map((track) => [track.track, track]));
  if (old.length === 0) return;
  console.table(old.map((track) => ({ track: track.track, truth: track.truth ?? 'stranger', 'old: names given': track.namesGiven.join(', '), 'new: names given': now.get(track.track)?.namesGiven.join(', ') || '(none)' })));
}

// live: the three checks from the studio, as GET /studio/faces showed their candidates.
function liveChecks(): Check[] {
  const frame = (sims: Record<string, number>) => Object.entries(sims).map(([name, score]) => ({ name, score }));
  const frames = [
    frame({ Rapha: 0.715, Flo: 0.678, Anderson: 0.644 }),
    frame({ Flo: 0.52, Tihana: 0.117, Denali: 0.115 }),
    frame({ Flo: 0.52, Tihana: 0.117, Denali: 0.115 }),
  ];
  return frames.map((matches, index) => ({
    track: 'Flo at the studio',
    at: index * 5000,
    truth: 'Flo',
    // The last two are the same check twice (the same scores): one embedding, kept.
    face: { box: [0, 0, 1, 1], score: 0.9, embedding: [1], matches, _trackedAge: index === 2 ? 1 : 0 },
    library: null,
  }));
}

function libraryChecks(): Check[] {
  const faces = readFaceLibrary().faces;
  const sessionOf = new Map<string, string>();
  for (const person of groupLibrary(faces)) for (const session of person.sessions) for (const face of session.faces) sessionOf.set(face.id, session.key);
  const people = groupLibrary(faces);
  const checks: Check[] = [];
  for (const person of people) {
    const ordered = [...person.sessions].reverse().flatMap((session) => session.faces);
    ordered.forEach((face, index) => {
      const library = faces.filter((other) => sessionOf.get(other.id) !== sessionOf.get(face.id));
      const inLibrary = library.some((other) => other.name === person.name);
      checks.push({ track: person.name, at: index * 5000, truth: inLibrary ? person.name : null, face: { box: [0, 0, 1, 1], score: 0.9, embedding: face.embedding, _trackedAge: 0 }, library });
    });
  }
  return checks;
}

function lineChecks(file: string): Check[] {
  const fixtures = JSON.parse(readFileSync(new URL('../../tests/fixtures/faces/browser-embeddings.json', import.meta.url), 'utf8')) as { images: Record<string, { faces: Array<{ embedding: number[] }> }> };
  const library: EnrolledFace[] = [['Obama', 'obama-2012.jpg'], ['Biden', 'biden-2021.jpg'], ['Harris', 'harris-2021.jpg']]
    .map(([name, image]) => ({ id: name!, name: name!, embedding: fixtures.images[image!]!.faces[0]!.embedding }));
  const checks: Check[] = [];
  for (const text of readFileSync(file, 'utf8').split('\n')) {
    if (!text.trim()) continue;
    const line = JSON.parse(text) as { t: number; frame: { w: number }; faces: Array<{ track: number; box: FaceBox; score: number; embedding: number[] | null; fresh?: boolean }> };
    for (const face of line.faces) {
      if (!face.embedding) continue;
      // Obama is the big face (both clips show his 2009 photo large); the astronauts are small.
      const big = (face.box[2] - face.box[0]) / line.frame.w > 0.1;
      checks.push({
        track: `track ${face.track}`,
        at: line.t,
        truth: big ? 'Obama' : null,
        face: { box: face.box, score: face.score, embedding: face.embedding, track: face.track, ...(face.fresh !== undefined ? { _trackedAge: face.fresh ? 0 : 1 } : {}) },
        library,
      });
    }
  }
  return checks;
}

const args = process.argv.slice(2);
summarize('live: the three studio checks (Flo, 2026-11-09)', liveChecks());
const library = libraryChecks();
summarize('library: each person\'s samples as one track, leave-one-session-out, a check every 5 s', library);
wrongDetail(library);
for (let i = args.indexOf('--lines'); i !== -1 && i + 1 < args.length; i = args.indexOf('--lines', i + 1)) {
  const file = args[i + 1]!;
  const checks = lineChecks(file);
  const sims = checks.filter((check) => check.truth === 'Obama').map((check) => cosineSimilarity(check.face.embedding!, check.library![0]!.embedding));
  summarize(`${file.split('/').at(-1)}: the face service at 5 fps (Obama vs his 2012 photo: ${Math.min(...sims).toFixed(3)} to ${Math.max(...sims).toFixed(3)})`, checks);
}
