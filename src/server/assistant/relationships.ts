// Relationships: a recognised person can change how the characters treat
// them. The heads stay themselves (same personality, same voices); for the
// people listed they get a one-line attitude in that turn's context, e.g. the
// boss gets playful respect while everyone else gets the usual attitude.
//
// Derived every turn from live recognition, never stored: the line exists only
// while the person is recognised in view (the face page's `people` reports),
// and goes when they leave the view, when recognition has not seen them for
// RELATIONSHIP_GRACE_MS (camera off or stale), when the reporting page
// disconnects, and on any restart. It never enters history or field notes.
// A broken file or an unknown name means no line, never a failed turn.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RELATIONSHIP_GRACE_MS = 10_000;

export interface Relationship {
  /** As in the face library. */
  name: string;
  attitude: string;
}

const MAX_ENTRIES = 50;
const MAX_ATTITUDE_CHARS = 400;

/**
 * Shareable, git-friendly settings live in config/ (TUBS_CONFIG_DIR); data/ is
 * for private, never-committed things (the face library, voice references).
 */
export function configDir(): string {
  return path.resolve(process.env.TUBS_CONFIG_DIR?.trim() || path.join(process.cwd(), 'config'));
}

export function relationshipsFile(): string {
  return path.join(configDir(), 'relationships.json');
}

let cache: { file: string; mtimeMs: number; entries: Relationship[] } | null = null;
let lastProblem = '';

function logOnce(problem: string): void {
  if (problem === lastProblem) return;
  lastProblem = problem;
  if (problem) console.warn(`[relationships] ${problem}; no relationship lines until it is fixed`);
}

/** Checks entries from the file or the dashboard; throws on anything malformed. */
export function validateRelationships(value: unknown): Relationship[] {
  if (!Array.isArray(value)) throw new Error('relationships must be a list');
  if (value.length > MAX_ENTRIES) throw new Error(`at most ${MAX_ENTRIES} relationships`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`entry ${index + 1} is not an object`);
    const { name, attitude } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error(`entry ${index + 1}: name is missing`);
    if (typeof attitude !== 'string' || !attitude.trim() || attitude.length > MAX_ATTITUDE_CHARS) throw new Error(`entry ${index + 1}: attitude is missing or too long`);
    const key = name.trim().toLowerCase();
    if (seen.has(key)) throw new Error(`${name.trim()} is listed twice`);
    seen.add(key);
    return { name: name.trim(), attitude: attitude.trim() };
  });
}

/** The entries, re-read when the file changes. Missing or broken: none (logged once). */
export function loadRelationships(): Relationship[] {
  const file = relationshipsFile();
  try {
    if (!existsSync(file)) {
      logOnce(`${file} not found`);
      return [];
    }
    const { mtimeMs } = statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.entries;
    const entries = validateRelationships(JSON.parse(readFileSync(file, 'utf8')));
    cache = { file, mtimeMs, entries };
    logOnce('');
    return entries;
  } catch (error) {
    cache = null;
    logOnce(`${file} is unusable (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
}

/** The dashboard saves the whole list; it applies from the next turn. */
export function saveRelationships(value: unknown): Relationship[] {
  const entries = validateRelationships(value);
  const file = relationshipsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  cache = null;
  return loadRelationships();
}

type Position = 'left' | 'center' | 'right';

// Who recognition sees now: name (lower case) -> when, where, and how many were in view.
const recognised = new Map<string, { name: string; position: Position; seenAt: number }>();
let inViewCount = 0;

/** The face page's report of who is in view, left to right. Replaces the last one. */
export function noteRecognised(people: ReadonlyArray<{ names: readonly string[]; position: Position }>, now = Date.now()): void {
  recognised.clear();
  inViewCount = people.length;
  for (const person of people) {
    for (const name of person.names) {
      const clean = name.trim();
      if (clean) recognised.set(clean.toLowerCase(), { name: clean, position: person.position, seenAt: now });
    }
  }
}

/** The page that reported them is gone (reconnect, camera page closed): nobody is recognised. */
export function forgetRecognised(): void {
  recognised.clear();
  inViewCount = 0;
}

const WHERE: Record<Position, string> = { left: 'the one on the left', center: 'the one in the middle', right: 'the one on the right' };

/** This turn's relationship lines: one per listed person recognised in view now. */
export function relationshipLines(enabled: boolean, now = Date.now()): string[] {
  if (!enabled || recognised.size === 0) return [];
  const entries = loadRelationships();
  if (entries.length === 0) return [];
  const lines: string[] = [];
  for (const entry of entries) {
    const seen = recognised.get(entry.name.toLowerCase());
    if (!seen || now - seen.seenAt > RELATIONSHIP_GRACE_MS) continue;
    const where = inViewCount > 1 ? ` (${WHERE[seen.position]})` : '';
    lines.push(`${entry.name} is in front of you${where}. ${entry.attitude}`);
  }
  return lines;
}
