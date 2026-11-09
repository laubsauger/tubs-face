import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// The face library holds real people's faces and is curated by hand. On
// 2026-11-09 five people went out of the live library at once, with no copy to
// bring them back and nothing saying what did it. So: every write keeps the
// file as it was, every change is logged with who asked, a backup can be put
// back exactly, and curation (remove, move) touches only what it names.

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-library-'));
const libraryFile = path.join(dir, 'face-library.json');
process.env.TUBS_FACE_LIBRARY = libraryFile;
const library = await import('./library.js');

const face = (id: string, name: string, createdAt: number) => ({ id, name, embedding: [createdAt, 0.5, -0.25], createdAt, thumbnail: `data:image/jpeg;base64,${id}` });
const START = {
  faces: [
    face('f1', 'Flo', 1), face('f2', 'Flo', 2), face('r1', 'Rapha', 3), face('r2', 'Rapha', 4),
    face('v1', 'Vincent', 5), face('v2', 'Vincent', 6), face('a1', 'Anderson', 7),
  ],
};
const T0 = Date.parse('2026-11-09T17:00:00Z');
const onDisk = () => JSON.parse(readFileSync(libraryFile, 'utf8')) as typeof START;
const backups = () => library.backupFiles();

beforeEach(() => {
  // The starting library (backups and the log carry on: each test looks at what it adds).
  writeFileSync(libraryFile, JSON.stringify(START));
  library.resetLibraryUndo();
});

describe('every library write', () => {
  it('first keeps the file as it was, readable by its owner only', () => {
    const before = readFileSync(libraryFile, 'utf8');
    const count = backups().length;
    library.removeFaces(['r2'], T0 + 1000, 'test');
    const made = backups().slice(count);
    expect(made).toHaveLength(1);
    expect(readFileSync(path.join(library.backupDir, made[0]!), 'utf8')).toBe(before);
    expect(statSync(path.join(library.backupDir, made[0]!)).mode & 0o777).toBe(0o600);
  });

  it('is logged with what it did, to whom, how many and who asked; never an embedding', () => {
    library.removePerson('Vincent', T0 + 2000, 'POST /memory/library/remove from 192.168.1.20');
    const entry = library.readEditLog().at(-1)!;
    expect(entry).toMatchObject({ action: 'remove person', names: ['Vincent'], count: 2, origin: 'POST /memory/library/remove from 192.168.1.20', samplesNow: 5 });
    expect(readFileSync(library.editLogPath, 'utf8')).not.toContain('embedding');
  });
});

describe('backups', () => {
  it('keep the newest 20, and for a week the library as it was before each burst of edits', () => {
    // Rotation is by file name time: write 30 edits one second apart (one burst), then one an hour later.
    const first = backups().length;
    for (let i = 0; i < 30; i += 1) library.removeFaces([`none-${i}`], T0, 'test'); // nothing to remove: no write
    expect(backups().length).toBe(first);
    let at = T0 + 3_600_000;
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(libraryFile, JSON.stringify({ faces: [...START.faces, face(`x${i}`, 'Burst', i + 10)] }));
      library.writeFaceLibrary({ faces: START.faces }, { action: 'write', names: [], count: 0, origin: 'test' }, at);
      at += 1000;
    }
    library.writeFaceLibrary({ faces: START.faces }, { action: 'write', names: [], count: 0, origin: 'test' }, at + 3_600_000);
    const files = backups().filter((file) => library.backupTime(file) >= T0 + 3_600_000);
    // 20 newest, plus the burst's first (the library before it began).
    expect(files.length).toBe(21);
    expect(files[0]).toBe(new Date(T0 + 3_600_000).toISOString().replace(/:/g, '-') + '.json');
  });

  it('a restore brings back exactly that file, and keeps the library it replaced', () => {
    library.removePerson('Vincent', T0 + 7_200_000, 'test');
    library.removePerson('Anderson', T0 + 7_201_000, 'test');
    const taken = library.listBackups().find((backup) => backup.people.some((person) => person.name === 'Vincent') && backup.people.some((person) => person.name === 'Anderson'))!;
    const original = readFileSync(path.join(library.backupDir, taken.id), 'utf8');
    expect(library.backupDiff(taken.id)).toMatchObject({ back: [{ name: 'Vincent', samples: 2 }, { name: 'Anderson', samples: 1 }], gone: [], changed: [] });
    const replaced = readFileSync(libraryFile, 'utf8');
    expect(library.restoreBackup(taken.id, 'test', T0 + 7_300_000)).toBe(true);
    expect(readFileSync(libraryFile, 'utf8')).toBe(original);
    expect(library.listBackups().some((backup) => readFileSync(path.join(library.backupDir, backup.id), 'utf8') === replaced)).toBe(true);
    expect(library.readEditLog().at(-1)).toMatchObject({ action: 'restore', origin: 'test' });
    expect(library.restoreBackup('../face-library.json', 'test')).toBe(false);
  });
});

describe('curation', () => {
  it('moving a sample keeps its embedding, photo, time and id, and changes only its owner', () => {
    const before = onDisk().faces.find((each) => each.id === 'r1')!;
    const change = library.moveFaces(['r1'], 'flo', T0 + 10_000, 'test');
    expect(change).toMatchObject({ moved: [{ id: 'r1', from: 'Rapha' }], to: 'Flo' });
    const after = onDisk().faces.find((each) => each.id === 'r1')!;
    expect(after).toEqual({ ...before, name: 'Flo' });
    expect(onDisk().faces.filter((each) => each.id !== 'r1')).toEqual(START.faces.filter((each) => each.id !== 'r1'));
  });

  it('removing one sample never touches the others', () => {
    library.removeFaces(['f2'], T0 + 20_000, 'test');
    expect(onDisk().faces).toEqual(START.faces.filter((each) => each.id !== 'f2'));
  });

  it('can be undone in one step for a minute, then not', () => {
    const removed = library.removeFaces(['r1', 'v2'], T0 + 30_000, 'test');
    expect(library.undoLibraryChange(removed.undo, T0 + 40_000, 'test')).toBe(true);
    expect(onDisk().faces).toEqual(START.faces);
    const moved = library.moveFaces(['a1'], 'Rapha', T0 + 50_000, 'test');
    expect(library.undoLibraryChange(moved.undo, T0 + 50_000 + library.UNDO_MS + 1, 'test')).toBe(false);
    expect(onDisk().faces.find((each) => each.id === 'a1')!.name).toBe('Rapha');
  });
});
