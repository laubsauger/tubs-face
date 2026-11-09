// Face library audit: how well the people in the library are told apart, and
// which samples look like someone else (candidates to remove in the People
// tab's library dialog). Local only. Prints names, sample numbers, times and
// similarities, never an embedding.
//
//   npx tsx src/scripts/face-library-audit.ts [--json <file>]
//
// The library is data/face-library.json, or TUBS_FACE_LIBRARY. "Sample #n" is
// the person's n-th sample in time order (1-based), as the library dialog
// lists them oldest first within a person; the time says which.
//
// Leave-one-session-out probes: each sample is matched, as a live frame would
// be, against the library without its own capture session (samples less than
// 5 minutes apart, client/face/library-sessions.ts), so a pose is not matched
// against its near-duplicates from the same sitting.

import { writeFileSync } from 'node:fs';
import { readFaceLibrary } from '../server/faces/library.js';
import { cosineSimilarity } from '../client/face/matching.js';
import { groupLibrary } from '../client/face/library-sessions.js';
import type { EnrolledFace } from '../shared/contracts/faces.js';

interface Sample { face: EnrolledFace; person: string; index: number; session: string }

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const round = (value: number) => Math.round(value * 1000) / 1000;
const when = (face: EnrolledFace) => (face.createdAt ? new Date(face.createdAt).toISOString().replace('T', ' ').slice(0, 19) : 'undated');

const faces = readFaceLibrary().faces;
const people = groupLibrary(faces);
const samples: Sample[] = [];
for (const person of people) {
  const ordered = [...person.sessions].reverse().flatMap((session) => session.faces.map((face) => ({ face, session: session.key })));
  ordered.forEach(({ face, session }, index) => samples.push({ face, person: person.name, index: index + 1, session }));
}
const names = people.map((person) => person.name);
const byPerson = new Map(names.map((name) => [name, samples.filter((sample) => sample.person === name)]));

function centroid(list: Sample[]): number[] {
  const sum = new Array<number>(list[0]?.face.embedding.length ?? 0).fill(0);
  for (const sample of list) sample.face.embedding.forEach((value, index) => { sum[index]! += value; });
  const norm = Math.sqrt(sum.reduce((total, value) => total + value * value, 0)) || 1;
  return sum.map((value) => value / norm);
}
const centroids = new Map(names.map((name) => [name, centroid(byPerson.get(name)!)]));
const sim = (a: Sample, b: Sample) => cosineSimilarity(a.face.embedding, b.face.embedding);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? NaN;
  return { n: values.length, min: round(sorted[0] ?? NaN), p10: round(pick(0.1)), median: round(pick(0.5)), max: round(sorted.at(-1) ?? NaN) };
};

// 1. Per person: how alike their own samples are.
const spread = names.map((name) => {
  const own = byPerson.get(name)!;
  const toOwn = own.map((sample) => {
    const rest = own.filter((other) => other !== sample);
    return rest.length ? cosineSimilarity(sample.face.embedding, centroid(rest)) : NaN;
  }).filter(Number.isFinite);
  const pairs: number[] = [];
  for (let i = 0; i < own.length; i += 1) for (let j = i + 1; j < own.length; j += 1) pairs.push(sim(own[i]!, own[j]!));
  return { name, samples: own.length, sessions: new Set(own.map((sample) => sample.session)).size, toOwnCentroid: stats(toOwn), pairwise: stats(pairs) };
});

// 2. Pairs of people: centroids, and the nearest samples across them.
const pairsOfPeople: Array<{ a: string; b: string; centroids: number; nearestSamples: number; nearest: string; meanCross: number }> = [];
for (let i = 0; i < names.length; i += 1) {
  for (let j = i + 1; j < names.length; j += 1) {
    const a = names[i]!;
    const b = names[j]!;
    let nearest = { value: -1, label: '' };
    let total = 0;
    let count = 0;
    for (const x of byPerson.get(a)!) {
      for (const y of byPerson.get(b)!) {
        const value = sim(x, y);
        total += value;
        count += 1;
        if (value > nearest.value) nearest = { value, label: `${a} #${x.index} (${when(x.face)}) ~ ${b} #${y.index} (${when(y.face)})` };
      }
    }
    pairsOfPeople.push({ a, b, centroids: round(cosineSimilarity(centroids.get(a)!, centroids.get(b)!)), nearestSamples: round(nearest.value), nearest: nearest.label, meanCross: round(total / count) });
  }
}
pairsOfPeople.sort((x, y) => y.nearestSamples - x.nearestSamples);

// 2b. Samples of different people alike enough to name each other (at or over the match threshold).
const confusable: Array<{ a: string; b: string; sim: number }> = [];
for (let i = 0; i < samples.length; i += 1) {
  for (let j = i + 1; j < samples.length; j += 1) {
    const x = samples[i]!;
    const y = samples[j]!;
    if (x.person === y.person) continue;
    const value = sim(x, y);
    if (value >= 0.65) confusable.push({ a: `${x.person} #${x.index} (${when(x.face)})`, b: `${y.person} #${y.index} (${when(y.face)})`, sim: round(value) });
  }
}
confusable.sort((x, y) => y.sim - x.sim);
const involvement = new Map<string, number>();
for (const pair of confusable) for (const side of [pair.a, pair.b]) involvement.set(side, (involvement.get(side) ?? 0) + 1);

// 3. Samples that look like someone else.
const outliers = samples.flatMap((sample) => {
  const own = byPerson.get(sample.person)!.filter((other) => other !== sample);
  if (own.length === 0) return [];
  const ownCentroid = cosineSimilarity(sample.face.embedding, centroid(own));
  const ownNearest = Math.max(...own.map((other) => sim(sample, other)));
  let other = { name: '', centroid: -1, nearest: -1, nearestLabel: '' };
  for (const name of names) {
    if (name === sample.person) continue;
    const toCentroid = cosineSimilarity(sample.face.embedding, centroids.get(name)!);
    if (toCentroid > other.centroid) other = { ...other, name, centroid: toCentroid };
  }
  let nearestOther = { value: -1, label: '' };
  for (const candidate of samples) {
    if (candidate.person === sample.person) continue;
    const value = sim(sample, candidate);
    if (value > nearestOther.value) nearestOther = { value, label: `${candidate.person} #${candidate.index}` };
  }
  const reasons = [
    other.centroid >= ownCentroid ? `nearer ${other.name}'s centroid (${round(other.centroid)}) than its own (${round(ownCentroid)})` : '',
    nearestOther.value >= ownNearest ? `its nearest sample is ${nearestOther.label} (${round(nearestOther.value)}), not one of its own (${round(ownNearest)})` : '',
    ownCentroid < 0.45 ? `far from its own centroid (${round(ownCentroid)})` : '',
  ].filter(Boolean);
  return reasons.length ? [{ person: sample.person, sample: sample.index, at: when(sample.face), ownCentroid: round(ownCentroid), nearestOther: round(nearestOther.value), reasons }] : [];
});

// 4. Leave-one-session-out probes, matched as the browser matches (best sample per name).
interface Probe { person: string; sample: number; truthInLibrary: boolean; top: string; topSim: number; second: string | null; secondSim: number; ownSim: number | null }
const probes: Probe[] = samples.map((sample) => {
  const library = samples.filter((other) => other.session !== sample.session || other.person !== sample.person);
  const best = new Map<string, number>();
  for (const other of library) best.set(other.person, Math.max(best.get(other.person) ?? -1, sim(sample, other)));
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  return {
    person: sample.person,
    sample: sample.index,
    truthInLibrary: best.has(sample.person),
    top: ranked[0]?.[0] ?? '',
    topSim: ranked[0]?.[1] ?? 0,
    second: ranked[1]?.[0] ?? null,
    secondSim: ranked[1]?.[1] ?? 0,
    ownSim: best.get(sample.person) ?? null,
  };
});

// What a threshold and a margin would do to those probes.
const grid = [0.01, 0.03, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2].map((margin) => {
  let right = 0;
  let wrong = 0;
  let held = 0;
  for (const probe of probes) {
    const accepted = probe.topSim >= 0.65 && probe.topSim - probe.secondSim >= margin;
    if (!accepted) held += 1;
    else if (probe.top === probe.person) right += 1;
    else wrong += 1;
  }
  return { threshold: 0.65, margin, namedRight: right, namedWrong: wrong, leftUnknown: held };
});
const wrongTop = probes.filter((probe) => probe.top !== probe.person && probe.topSim >= 0.6)
  .map((probe) => ({ person: probe.person, sample: probe.sample, namedAs: probe.top, sim: round(probe.topSim), runnerUp: probe.second, runnerUpSim: round(probe.secondSim), own: probe.ownSim === null ? null : round(probe.ownSim), lead: round(probe.topSim - probe.secondSim) }));
const rightLeads = probes.filter((probe) => probe.top === probe.person && probe.topSim >= 0.65).map((probe) => probe.topSim - probe.secondSim);

const report = { samples: samples.length, people: names.length, spread, closestPairs: pairsOfPeople.slice(0, 8), confusable, outliers, probes: { grid, wrongTop, rightLeads: stats(rightLeads) } };

console.log(`${samples.length} samples, ${names.length} people\n`);
console.log('Per person (similarity of each sample to the centroid of the others; all pairs):');
console.table(spread.map((row) => ({ person: row.name, samples: row.samples, sessions: row.sessions, 'to own min': row.toOwnCentroid.min, 'to own median': row.toOwnCentroid.median, 'pairs min': row.pairwise.min, 'pairs median': row.pairwise.median })));
console.log('Closest pairs of people (nearest samples across them):');
console.table(pairsOfPeople.slice(0, 8).map((row) => ({ pair: `${row.a} / ${row.b}`, centroids: row.centroids, 'nearest samples': row.nearestSamples, 'mean across': row.meanCross, which: row.nearest })));
const floRapha = pairsOfPeople.find((row) => [row.a, row.b].sort().join('/') === ['Flo', 'Rapha'].sort().join('/'));
if (floRapha) console.log(`Flo / Rapha: centroids ${floRapha.centroids}, nearest samples ${floRapha.nearestSamples} (${floRapha.nearest}), mean across ${floRapha.meanCross}\n`);
console.log(`Samples of different people at or over the match threshold (0.65) to each other: ${confusable.length} pairs`);
console.table(confusable);
console.log('Samples in the most such pairs:');
console.table([...involvement.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([sample, pairs]) => ({ sample, pairs })));
console.log('Samples that look like someone else:');
console.table(outliers.map((row) => ({ person: row.person, sample: row.sample, taken: row.at, 'to own': row.ownCentroid, why: row.reasons.join('; ') })));
console.log('Leave-one-session-out probes: what threshold 0.65 and a margin would name');
console.table(grid);
console.log('Probes whose best match was someone else (at 0.60 or more):');
console.table(wrongTop);
console.log('Lead over the runner-up when the best match was right (and at 0.65 or more):', report.probes.rightLeads);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
