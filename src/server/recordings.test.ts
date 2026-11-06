import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendChunk, createRecording, finishRecording } from './recordings.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), 'tubs-recordings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = new Date(2026, 10, 4, 18, 30, 5);
const contents = (file: string) => readFileSync(join(dir, file.replace(/\.mp4$/, '.part.mp4')), 'utf8');

describe('recordings', () => {
  // The browser retries a piece when the response is lost (server restart,
  // network blip). Writing it twice would break the video from there on.
  it('a piece resent after a lost response is written once', async () => {
    const file = await createRecording(dir, 'mp4', at);
    await appendChunk(dir, file, 0, Buffer.from('aaa'));
    await appendChunk(dir, file, 3, Buffer.from('bb'));
    await appendChunk(dir, file, 3, Buffer.from('bb'));
    expect(contents(file)).toBe('aaabb');
  });

  // A missing piece means the browser and the file disagree; appending past
  // the gap would silently save a broken video.
  it('refuses a piece that would leave a gap', async () => {
    const file = await createRecording(dir, 'mp4', at);
    await appendChunk(dir, file, 0, Buffer.from('aaa'));
    await expect(appendChunk(dir, file, 5, Buffer.from('cc'))).rejects.toMatchObject({ name: 'ConflictError' });
    expect(contents(file)).toBe('aaa');
  });

  // The file name comes from the browser; only names this server made are used.
  it('never touches files outside the recordings folder', async () => {
    const recordings = join(dir, 'recordings');
    mkdirSync(recordings);
    writeFileSync(join(dir, 'escape.part.mp4'), 'precious');
    for (const file of ['../escape.mp4', `${join(dir, 'escape.mp4')}`, 42]) {
      await expect(appendChunk(recordings, file, 8, Buffer.from('x'))).rejects.toMatchObject({ name: 'BadRequestError' });
    }
    expect(readFileSync(join(dir, 'escape.part.mp4'), 'utf8')).toBe('precious');
  });

  it('two takes in the same second get their own files', async () => {
    const first = await createRecording(dir, 'mp4', at);
    const second = await createRecording(dir, 'mp4', at);
    expect(first).toBe('tubs-2026-11-04_18-30-05.mp4');
    expect(second).toBe('tubs-2026-11-04_18-30-05-2.mp4');
  });

  // Without ffmpeg the take must still be there, as Chrome recorded it.
  it('keeps the recording as recorded when ffmpeg is missing', async () => {
    const file = await createRecording(dir, 'mp4', at);
    await appendChunk(dir, file, 0, Buffer.from('video bytes'));
    const result = await finishRecording(dir, file, '/nonexistent/ffmpeg');
    expect(result).toMatchObject({ file, remuxed: false });
    expect(readFileSync(join(dir, file), 'utf8')).toBe('video bytes');
    expect(readdirSync(dir).sort()).toEqual(['raw', file]);
    expect(existsSync(result.path)).toBe(true);
  });

  // A take was lost when an app saved over its finished video; Chrome's own
  // file is the copy that survives that.
  it("keeps Chrome's file in raw/ next to the finished video", async () => {
    const file = await createRecording(dir, 'mp4', at);
    await appendChunk(dir, file, 0, Buffer.from('video bytes'));
    await finishRecording(dir, file, '/nonexistent/ffmpeg');
    expect(readFileSync(join(dir, 'raw', file), 'utf8')).toBe('video bytes');
    expect(existsSync(join(dir, file.replace(/\.mp4$/, '.part.mp4')))).toBe(false);
  });

  // A finish cut off by a server restart leaves only the raw file; finishing
  // again must still produce the video instead of calling the take unknown.
  it('finishes a take that only has its raw file left', async () => {
    const file = await createRecording(dir, 'mp4', at);
    await appendChunk(dir, file, 0, Buffer.from('video bytes'));
    await finishRecording(dir, file, '/nonexistent/ffmpeg');
    rmSync(join(dir, file));
    const result = await finishRecording(dir, file, '/nonexistent/ffmpeg');
    expect(readFileSync(result.path, 'utf8')).toBe('video bytes');
  });
});

// Chrome restarts its video encoder when the tab changes size and records the
// new encoder's frames without the settings they need. QuickTime froze a real
// take there at 0:39 of 1:17 while ffmpeg played on. The fixture is a 4.5 s
// recording of a test page by Chrome 157 with the tab resized at 2 s; copied
// as is, the Mac's decoder stops at 1.9 s.
const canCheckPlayback = process.platform === 'darwin' && (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('swift', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!canCheckPlayback)('recordings on a Mac', () => {
  it('a take in which Chrome restarted its encoder plays to the end in QuickTime\'s decoder', async () => {
    const fixture = readFileSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'chrome-encoder-restart.mp4'));
    const file = await createRecording(dir, 'mp4', at);
    await appendChunk(dir, file, 0, fixture);
    const result = await finishRecording(dir, file);

    const script = join(import.meta.dirname, '..', '..', 'scripts', 'check-playback.swift');
    let report: string;
    try {
      report = execFileSync('swift', [script, result.path]).toString();
    } catch (error) {
      report = String((error as { stdout?: Buffer }).stdout ?? error);
    }
    const playback = JSON.parse(report) as { decodedTo: number; duration: number; completed: boolean };
    expect(playback.completed).toBe(true);
    expect(playback.decodedTo).toBeGreaterThan(playback.duration - 0.2);
    expect(readFileSync(join(dir, 'raw', file)).equals(fixture)).toBe(true);
  }, 60_000);
});
