import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/**
 * Share of the file's audio power at one frequency (decoded by ffmpeg to
 * 16 kHz mono; Goertzel over 0.1 s blocks, so a tone a hertz off still counts).
 */
function toneShare(path: string, hz: number): number {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const block = 1600;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / 16000);
  let tone = 0;
  let total = 0;
  for (let start = 0; start + block <= x.length; start += block) {
    let s1 = 0;
    let s2 = 0;
    for (let i = start; i < start + block; i += 1) {
      const s0 = x[i]! + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
      total += x[i]! * x[i]!;
    }
    tone += (2 * (s1 * s1 + s2 * s2 - coeff * s1 * s2)) / block;
  }
  return total > 0 ? tone / total : 0;
}

const MIC_HZ = 440;

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

test('R records the face window and its sound into one plain MP4', async ({ page, request }) => {
  test.skip(!hasFfprobe, 'needs ffprobe and ffmpeg to check the saved file');
  // The mic is a steady tone made in the page, no device opened. These test
  // runs have no audio output (it disturbed the machine's audio), so the tab's
  // own sound (Tubs' voice) is silence here; the mic tone is what proves the
  // recorder saves sound at all, not just an audio track. Without this check a
  // recorder that saved silence passed.
  await page.addInitScript((hz) => {
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      if (!constraints?.audio || constraints.video) return original(constraints);
      const context = new AudioContext();
      const oscillator = new OscillatorNode(context, { frequency: hz });
      const out = context.createMediaStreamDestination();
      oscillator.connect(new GainNode(context, { gain: 0.3 })).connect(out);
      oscillator.start();
      void context.resume();
      return out.stream;
    };
  }, MIC_HZ);
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
  // One finished file, no .part left behind, and Chrome's own file kept in raw/.
  const added = readdirSync(dir).filter((file) => !before.has(file) && file !== 'raw');
  expect(added).toHaveLength(1);
  expect(added[0]).toMatch(/^tubs-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/);
  expect(existsSync(join(dir, 'raw', added[0]!))).toBe(true);

  const path = join(dir, added[0]!);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', path]).toString()) as {
    streams: Array<{ codec_type: string; codec_name: string }>;
    format: { duration: string };
  };
  expect(probe.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`).sort()).toEqual(['audio:aac', 'video:h264']);
  expect(Number(probe.format.duration)).toBeGreaterThan(2);
  expect(topLevelBoxes(path)).not.toContain('moof');
  // The room is in it: most of the sound is the mic's tone.
  expect(toneShare(path, MIC_HZ), 'share of the mic tone in the recorded audio').toBeGreaterThan(0.5);

  // QuickTime's decoder, not ffmpeg's, is the one that froze on Chrome's file.
  if (process.platform === 'darwin') {
    let report: string;
    try {
      report = execFileSync('swift', [join(process.cwd(), 'scripts', 'check-playback.swift'), path]).toString();
    } catch (error) {
      report = String((error as { stdout?: Buffer }).stdout ?? error);
    }
    const playback = JSON.parse(report) as { decodedTo: number; duration: number; completed: boolean };
    expect(playback.completed).toBe(true);
    expect(playback.decodedTo).toBeGreaterThan(playback.duration - 0.5);
  }
});
