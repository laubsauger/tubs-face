import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { MOCK, chunk, openFace, resetMock, send } from './helpers.js';

// The record button exists so nobody has to run a screen recorder during a
// session: what the face window shows and plays, and the room, end up in one
// video file that can be shared as is.

const hasFfprobe = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Top-level MP4 boxes; a fragmented file (moof) trips up some editors and upload forms. */
function topLevelBoxes(path: string): string[] {
  const data = readFileSync(path);
  const boxes: string[] = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const size = data.readUInt32BE(offset);
    boxes.push(data.toString('latin1', offset + 4, offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return boxes;
}

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

test('R records the face window and its sound into one plain MP4', async ({ page, request }) => {
  test.skip(!hasFfprobe, 'needs ffprobe and ffmpeg to check the saved file');
  await openFace(page, request);
  const { dir } = await (await request.get(`${MOCK}/__test/recordings`)).json() as { dir: string };
  const before = new Set(readdirSync(dir));

  await page.keyboard.press('r');
  await expect(page.locator('#recording-toggle.is-rec')).toBeVisible();
  await send(request,
    { type: 'turn_start', turnId: 't-rec' },
    chunk('t-rec', 0, 'Recorded line.', 1500),
    { type: 'speak_end', turnId: 't-rec', fullText: 'Recorded line.' },
  );
  await page.waitForTimeout(2500);
  await page.keyboard.press('r');

  await expect(page.locator('#recording-show')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#recording-toggle')).toHaveText('Rec');
  // One finished file, no .part left behind.
  const added = readdirSync(dir).filter((file) => !before.has(file));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatch(/^tubs-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/);

  const path = join(dir, added[0]!);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', path]).toString()) as {
    streams: Array<{ codec_type: string; codec_name: string }>;
    format: { duration: string };
  };
  expect(probe.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`).sort()).toEqual(['audio:aac', 'video:h264']);
  expect(Number(probe.format.duration)).toBeGreaterThan(2);
  expect(topLevelBoxes(path)).not.toContain('moof');
});
