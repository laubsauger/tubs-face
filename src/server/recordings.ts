// Videos recorded in the face window (the tab, Tubs' voice and the mic). The
// browser uploads each piece as it is recorded, so a crash or reload loses
// seconds, not the take. Files land in ~/Movies/tubs-recordings unless
// TUBS_RECORDINGS_DIR says otherwise.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { badRequest } from './routes/route-helpers.js';

const run = promisify(execFile);

export type RecordingExt = 'mp4' | 'webm';

// Only names this module made; anything else could point outside the folder.
const NAME_PATTERN = /^tubs-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.(mp4|webm)$/;
const REMUX_TIMEOUT_MS = 120_000;

export function recordingsDir(): string {
  return process.env.TUBS_RECORDINGS_DIR || join(os.homedir(), 'Movies', 'tubs-recordings');
}

/** Where the pieces go while recording: playable up to the last piece if the take never finishes. */
function partPath(dir: string, file: string): string {
  return join(dir, file.replace(/\.(mp4|webm)$/, '.part.$1'));
}

function checkedName(file: unknown): string {
  if (typeof file !== 'string' || !NAME_PATTERN.test(file)) throw badRequest('Unknown recording');
  return file;
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** Starts an empty recording and returns its file name. */
export async function createRecording(dir: string, ext: RecordingExt, now = new Date()): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (let n = 1; ; n += 1) {
    const file = `tubs-${stamp(now)}${n > 1 ? `-${n}` : ''}.${ext}`;
    if (existsSync(join(dir, file))) continue;
    try {
      await (await open(partPath(dir, file), 'wx')).close();
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Appends a piece that starts at `offset` bytes. A retry after a lost
 * response finds the piece already there and writes nothing, since a
 * duplicated piece would break the video from that point on.
 */
export async function appendChunk(dir: string, file: unknown, offset: number, data: Buffer): Promise<void> {
  const path = partPath(dir, checkedName(file));
  const size = (await stat(path).catch(() => null))?.size;
  if (size === undefined) throw badRequest('Unknown recording');
  if (size === offset + data.length && data.length > 0) return;
  if (size !== offset) {
    const error = new Error(`Recording has ${size} bytes, piece starts at ${offset}`);
    error.name = 'ConflictError';
    throw error;
  }
  await appendFile(path, data);
}

/**
 * Closes a recording. Chrome records fragmented MP4, which some editors and
 * upload forms reject; ffmpeg rewrites it as a plain MP4 without re-encoding.
 * Without ffmpeg (or if it fails) the recording is kept as recorded.
 */
export async function finishRecording(dir: string, file: unknown, ffmpeg = 'ffmpeg'): Promise<{ file: string; path: string; remuxed: boolean }> {
  const name = checkedName(file);
  const part = partPath(dir, name);
  const path = join(dir, name);
  if (!existsSync(part)) {
    if (existsSync(path)) return { file: name, path, remuxed: false };
    throw badRequest('Unknown recording');
  }
  if (name.endsWith('.mp4')) {
    try {
      await run(ffmpeg, ['-v', 'error', '-y', '-i', part, '-c', 'copy', '-movflags', '+faststart', path], { timeout: REMUX_TIMEOUT_MS });
      await unlink(part);
      return { file: name, path, remuxed: true };
    } catch (error) {
      console.warn(`[recordings] kept ${name} as recorded, remux failed: ${error instanceof Error ? error.message : String(error)}`);
      await unlink(path).catch(() => {});
    }
  }
  await rename(part, path);
  return { file: name, path, remuxed: false };
}

/** Shows the recording in Finder (macOS only). */
export async function revealRecording(dir: string, file: unknown): Promise<void> {
  const name = checkedName(file);
  const path = [join(dir, name), partPath(dir, name)].find((candidate) => existsSync(candidate));
  if (!path) throw badRequest('Unknown recording');
  if (process.platform !== 'darwin') throw new Error('Show in Finder works on macOS only');
  await run('open', ['-R', path]);
}
