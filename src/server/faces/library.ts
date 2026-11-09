import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { EnrolledFace, FaceLibraryDocument } from '../../shared/contracts/faces.js';

// Private, never in git: data/ (TUBS_FACE_LIBRARY points elsewhere, e.g. for tests).
export const faceLibraryPath = resolve(process.env.TUBS_FACE_LIBRARY?.trim() || resolve(process.cwd(), 'data/face-library.json'));

// Next to the library: a copy of it before every write, and a log of every
// change (who, what, how many; never an embedding). On 2026-11-09 five people
// went out of the live library at once and nothing said how; now the backups
// bring them back and the log says what did it.
const stem = basename(faceLibraryPath).replace(/\.json$/i, '');
export const backupDir = join(dirname(faceLibraryPath), `${stem}.backups`);
export const editLogPath = join(dirname(faceLibraryPath), `${stem}.log`);

/** Backups kept: the newest ones, and for this long the first of each burst of edits and the newest of each day. */
export const BACKUPS_KEPT = 20;
export const BACKUP_DAYS = 7;
/** Edits closer together than this are one burst: removing a person sample by sample is many writes. */
export const BURST_GAP_MS = 60_000;
const BACKUPS_MAX = 200;

export type LibraryAction = 'add' | 'remove sample' | 'remove person' | 'rename' | 'move' | 'restore' | 'undo' | 'write';

/** What a write does and who asked, for the edit log and the server log. */
export interface LibraryEdit {
  action: LibraryAction;
  /** The people it touches (for a move: from and to). */
  names: string[];
  /** Samples it touches. */
  count: number;
  /** Where it came from: the route and the caller's address, the face service's onboarding, auto onboarding. */
  origin: string;
  detail?: string;
}

export function readFaceLibrary(): FaceLibraryDocument {
  try {
    if (existsSync(faceLibraryPath)) {
      const parsed = JSON.parse(readFileSync(faceLibraryPath, 'utf8')) as Partial<FaceLibraryDocument>;
      return {
        faces: Array.isArray(parsed.faces) ? parsed.faces.filter(isEnrolledFaceLike) : [],
      };
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[faces] failed to read face library: ${error.message}`);
    }
  }
  return { faces: [] };
}

let peopleCache: { mtimeMs: number; count: number } | null = null;

/** How many people the library knows; read again only when the file changed (GET /studio asks often). */
export function libraryPeopleCount(): number {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(faceLibraryPath).mtimeMs;
  } catch {
    return 0;
  }
  if (peopleCache?.mtimeMs !== mtimeMs) peopleCache = { mtimeMs, count: new Set(readFaceLibrary().faces.map((face) => face.name)).size };
  return peopleCache.count;
}

/**
 * The one way the library is written. The file as it was is copied to the
 * backups first, the new one replaces it whole (a crash never leaves half a
 * file), and the change goes into the edit log and the server log.
 */
export function writeFaceLibrary(document: FaceLibraryDocument, edit: LibraryEdit = { action: 'write', names: [], count: 0, origin: 'unknown' }, now = Date.now()): void {
  mkdirSync(dirname(faceLibraryPath), { recursive: true });
  backupCurrent(now);
  const temp = `${faceLibraryPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(document, null, 2), { mode: 0o600 });
  renameSync(temp, faceLibraryPath);
  logEdit(edit, document.faces.length, now);
}

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/:/g, '-');
}

/** The backup's time, from its name (2026-11-09T17-25-58.123Z.json). */
export function backupTime(file: string): number {
  const iso = file.replace(/\.json$/, '').replace(/-\d+$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}

function backupCurrent(now: number): void {
  if (!existsSync(faceLibraryPath)) return;
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  let name = `${stampOf(now)}.json`;
  for (let n = 1; existsSync(join(backupDir, name)); n += 1) name = `${stampOf(now)}-${n}.json`;
  const target = join(backupDir, name);
  copyFileSync(faceLibraryPath, target);
  chmodSync(target, 0o600);
  pruneBackups(now);
}

/** The backups' file names, oldest first. */
export function backupFiles(): string[] {
  try {
    return readdirSync(backupDir).filter((file) => file.endsWith('.json')).sort((a, b) => backupTime(a) - backupTime(b) || a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Keeps the newest BACKUPS_KEPT, and for BACKUP_DAYS the first backup of each
 * burst of edits (the library as it was before them) and the newest of each day.
 */
export function pruneBackups(now = Date.now()): void {
  const files = backupFiles();
  const keep = new Set(files.slice(-BACKUPS_KEPT));
  const recent = files.filter((file) => now - backupTime(file) <= BACKUP_DAYS * 86_400_000);
  for (const file of recent) {
    const previous = files[files.indexOf(file) - 1];
    if (!previous || backupTime(file) - backupTime(previous) >= BURST_GAP_MS) keep.add(file);
  }
  const newestOfDay = new Map<string, string>();
  for (const file of recent) newestOfDay.set(new Date(backupTime(file)).toISOString().slice(0, 10), file);
  for (const file of newestOfDay.values()) keep.add(file);
  const kept = files.filter((file) => keep.has(file)).slice(-BACKUPS_MAX);
  for (const file of files) if (!kept.includes(file)) rmSync(join(backupDir, file), { force: true });
}

function logEdit(edit: LibraryEdit, total: number, now: number): void {
  const entry = { at: new Date(now).toISOString(), action: edit.action, names: edit.names, count: edit.count, origin: edit.origin, ...(edit.detail ? { detail: edit.detail } : {}), samplesNow: total };
  console.log(`[faces] library: ${edit.action} ${edit.names.join(' -> ') || '-'} (${edit.count} sample${edit.count === 1 ? '' : 's'}) by ${edit.origin}; ${total} samples now`);
  try {
    appendFileSync(editLogPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[faces] could not write the library edit log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The edit log, newest last; at most `limit` entries. */
export function readEditLog(limit = 200): Array<Record<string, unknown>> {
  try {
    return readFileSync(editLogPath, 'utf8').split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * The name a person already has in the library, if this one is theirs
 * ("flo", " Flo " are Flo): samples added to someone land under their name,
 * never as a second person beside them.
 */
export function canonicalPersonName(faces: readonly EnrolledFace[], name: string): string {
  const key = name.trim().toLowerCase();
  return faces.find((face) => face.name.trim().toLowerCase() === key)?.name.trim() ?? name.trim();
}

export function addFace(input: { name: string; embedding: number[]; thumbnail?: string }, origin = 'unknown'): EnrolledFace {
  const library = readFaceLibrary();
  const face: EnrolledFace = {
    id: createFaceId(),
    name: canonicalPersonName(library.faces, input.name),
    embedding: input.embedding,
    createdAt: Date.now(),
    ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
  };
  library.faces.push(face);
  writeFaceLibrary(library, { action: 'add', names: [face.name], count: 1, origin });
  return face;
}

export function deleteFace(id: string, origin = 'unknown'): boolean {
  const library = readFaceLibrary();
  const gone = library.faces.find((face) => face.id === id);
  if (!gone) return false;
  writeFaceLibrary({ faces: library.faces.filter((face) => face.id !== id) }, { action: 'remove sample', names: [gone.name], count: 1, origin });
  return true;
}

/** Removes every sample of this name (samples hold their thumbnails, so those go too). */
export function deleteFacesByName(name: string, origin = 'unknown'): number {
  return removePerson(name, Date.now(), origin).removed.length;
}

export function updateFace(id: string, patch: { name?: string }, origin = 'unknown'): EnrolledFace | null {
  const library = readFaceLibrary();
  const target = library.faces.find((face) => face.id === id);
  if (!target) {
    return null;
  }
  const before = target.name;
  if (typeof patch.name === 'string' && patch.name.trim()) {
    // Renamed to someone who is already there: they become one person.
    target.name = canonicalPersonName(library.faces.filter((face) => face.id !== id), patch.name);
  }
  writeFaceLibrary(library, { action: 'rename', names: [before, target.name], count: 1, origin });
  return target;
}

// Curation from the memory view (routes/memory-routes.ts): remove samples, move
// them to another person, and undo the last change for a minute (the backups
// hold every earlier state).

/** How long the last library change can be undone in one step. */
export const UNDO_MS = 60_000;

export interface LibraryChange {
  /** What the undo call takes ('' when nothing changed). */
  undo: string;
  /** Until when (ms since epoch). */
  until: number;
}

let lastChange: { token: string; at: number; revert(origin: string): void } | null = null;

function remember(revert: (origin: string) => void, now: number): LibraryChange {
  const token = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  lastChange = { token, at: now, revert };
  return { undo: token, until: now + UNDO_MS };
}

/** Removes these samples, and nothing else; returns what went (in library order) and how to undo it. */
export function removeFaces(ids: readonly string[], now = Date.now(), origin = 'unknown', action: LibraryAction = 'remove sample'): { removed: EnrolledFace[] } & LibraryChange {
  const wanted = new Set(ids);
  const library = readFaceLibrary();
  const removed: Array<{ face: EnrolledFace; at: number }> = [];
  library.faces.forEach((face, index) => {
    if (wanted.has(face.id)) removed.push({ face, at: index });
  });
  if (removed.length === 0) return { removed: [], undo: '', until: 0 };
  const names = [...new Set(removed.map((entry) => entry.face.name))];
  writeFaceLibrary({ faces: library.faces.filter((face) => !wanted.has(face.id)) }, { action, names, count: removed.length, origin }, now);
  return {
    removed: removed.map((entry) => entry.face),
    ...remember((undoOrigin) => {
      // Back where they were, unless something with their id is there again.
      const current = readFaceLibrary();
      const present = new Set(current.faces.map((face) => face.id));
      const back = removed.filter(({ face }) => !present.has(face.id));
      for (const { face, at } of back) current.faces.splice(Math.min(at, current.faces.length), 0, face);
      writeFaceLibrary(current, { action: 'undo', names, count: back.length, origin: undoOrigin, detail: `brings back what "${action}" took` });
    }, now),
  };
}

/** Every sample of this name; as removeFaces. */
export function removePerson(name: string, now = Date.now(), origin = 'unknown'): { removed: EnrolledFace[] } & LibraryChange {
  const key = name.trim().toLowerCase();
  return removeFaces(readFaceLibrary().faces.filter((face) => face.name.trim().toLowerCase() === key).map((face) => face.id), now, origin, 'remove person');
}

/**
 * These samples belong to someone else: the same embedding, photo, time and
 * id, under that person's name (as the library already spells it).
 */
export function moveFaces(ids: readonly string[], to: string, now = Date.now(), origin = 'unknown'): { moved: Array<{ id: string; from: string }>; to: string } & LibraryChange {
  const wanted = new Set(ids);
  const library = readFaceLibrary();
  const target = canonicalPersonName(library.faces.filter((face) => !wanted.has(face.id)), to);
  const moved: Array<{ id: string; from: string }> = [];
  for (const face of library.faces) {
    if (!wanted.has(face.id) || face.name === target) continue;
    moved.push({ id: face.id, from: face.name });
    face.name = target;
  }
  if (moved.length === 0) return { moved, to: target, undo: '', until: 0 };
  const from = [...new Set(moved.map((entry) => entry.from))];
  writeFaceLibrary(library, { action: 'move', names: [...from, target], count: moved.length, origin }, now);
  return {
    moved,
    to: target,
    ...remember((undoOrigin) => {
      const current = readFaceLibrary();
      let back = 0;
      for (const { id, from: owner } of moved) {
        const face = current.faces.find((each) => each.id === id);
        if (face && face.name === target) {
          face.name = owner;
          back += 1;
        }
      }
      writeFaceLibrary(current, { action: 'undo', names: [target, ...from], count: back, origin: undoOrigin, detail: 'moves them back' });
    }, now),
  };
}

/** Undoes the last change, if this is its token and the minute is not over. */
export function undoLibraryChange(token: string, now = Date.now(), origin = 'unknown'): boolean {
  if (!lastChange || !token || lastChange.token !== token || now - lastChange.at > UNDO_MS) return false;
  const change = lastChange;
  lastChange = null;
  change.revert(origin);
  return true;
}

/** Tests: forget the last change. */
export function resetLibraryUndo(): void {
  lastChange = null;
}

export interface LibraryBackup {
  /** The file name: what a restore takes. */
  id: string;
  at: number;
  samples: number;
  people: Array<{ name: string; samples: number }>;
}

function peopleOf(faces: readonly EnrolledFace[]): Array<{ name: string; samples: number }> {
  const counts = new Map<string, { name: string; samples: number }>();
  for (const face of faces) {
    const key = face.name.trim().toLowerCase();
    const entry = counts.get(key) ?? { name: face.name.trim(), samples: 0 };
    entry.samples += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.samples - a.samples || a.name.localeCompare(b.name));
}

function readBackup(id: string): FaceLibraryDocument | null {
  // Only a file name from the list: no paths.
  if (!backupFiles().includes(id)) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(backupDir, id), 'utf8')) as Partial<FaceLibraryDocument>;
    return { faces: Array.isArray(parsed.faces) ? parsed.faces.filter(isEnrolledFaceLike) : [] };
  } catch {
    return null;
  }
}

/** The backups, newest first: when, and who with how many samples (never an embedding). */
export function listBackups(): LibraryBackup[] {
  return backupFiles().reverse().flatMap((id) => {
    const document = readBackup(id);
    return document ? [{ id, at: backupTime(id), samples: document.faces.length, people: peopleOf(document.faces) }] : [];
  });
}

/** What restoring this backup changes, person by person, against the library now. */
export function backupDiff(id: string): { back: Array<{ name: string; samples: number }>; gone: Array<{ name: string; samples: number }>; changed: Array<{ name: string; from: number; to: number }>; unchanged: string[] } | null {
  const document = readBackup(id);
  if (!document) return null;
  const now = new Map(peopleOf(readFaceLibrary().faces).map((person) => [person.name.toLowerCase(), person]));
  const then = new Map(peopleOf(document.faces).map((person) => [person.name.toLowerCase(), person]));
  const back: Array<{ name: string; samples: number }> = [];
  const changed: Array<{ name: string; from: number; to: number }> = [];
  const unchanged: string[] = [];
  for (const [key, person] of then) {
    const current = now.get(key);
    if (!current) back.push(person);
    else if (current.samples !== person.samples) changed.push({ name: person.name, from: current.samples, to: person.samples });
    else unchanged.push(person.name);
  }
  const gone = [...now.entries()].filter(([key]) => !then.has(key)).map(([, person]) => person);
  return { back, gone, changed, unchanged };
}

/** Puts this backup back as the library, exactly as it was (the library now is backed up first). */
export function restoreBackup(id: string, origin = 'unknown', now = Date.now()): boolean {
  if (!readBackup(id)) return false;
  mkdirSync(dirname(faceLibraryPath), { recursive: true });
  // Taken first: backing up the library now prunes old backups, this one among them perhaps.
  const temp = `${faceLibraryPath}.${process.pid}.tmp`;
  copyFileSync(join(backupDir, id), temp);
  chmodSync(temp, 0o600);
  backupCurrent(now);
  renameSync(temp, faceLibraryPath);
  const restored = readFaceLibrary().faces;
  logEdit({ action: 'restore', names: peopleOf(restored).map((person) => person.name), count: restored.length, origin, detail: `from backup ${id}` }, restored.length, now);
  lastChange = null;
  return true;
}

function createFaceId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function isEnrolledFaceLike(value: unknown): value is EnrolledFace {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<EnrolledFace>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && Array.isArray(candidate.embedding);
}
