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
    expect(readdirSync(dir)).toEqual([file]);
    expect(existsSync(result.path)).toBe(true);
  });
});
