#!/usr/bin/env node
// Is the face really in the studio streams? Grabs one frame of each from the
// site node and fails if it is black (GET /studio once said "publishing" while
// both streams were black). Needs ffmpeg.
//
//   node scripts/check-studio-stream.mjs [rtsp://127.0.0.1:8554] [tubs-main,tubs-small] [--save <dir>]

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const saveAt = args.indexOf('--save');
const saveDir = saveAt >= 0 ? args.splice(saveAt, 2)[1] : null;
const base = (args[0] ?? 'rtsp://127.0.0.1:8554').replace(/\/+$/, '');
const paths = (args[1] ?? 'tubs-main,tubs-small').split(',').filter(Boolean);
const SIZE = 256;

let failed = false;
for (const streamPath of paths) {
  let raw;
  try {
    raw = execFileSync('ffmpeg', ['-v', 'error', '-rtsp_transport', 'tcp', '-i', `${base}/${streamPath}`, '-frames:v', '1', '-vf', `scale=${SIZE}:${SIZE}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    console.log(`${streamPath}: no frame (${error instanceof Error ? error.message.split('\n')[0] : error})`);
    failed = true;
    continue;
  }
  let lit = 0;
  let nearWhite = 0;
  for (let i = 0; i < raw.length; i += 3) {
    const high = Math.max(raw[i], raw[i + 1], raw[i + 2]);
    const low = Math.min(raw[i], raw[i + 1], raw[i + 2]);
    if (high > 40) lit += 1;
    if (low >= 200 && high - low <= 40) nearWhite += 1;
  }
  const share = lit / (SIZE * SIZE);
  const black = share < 0.002;
  if (black) failed = true;
  console.log(`${streamPath}: ${black ? 'BLACK' : 'face'} (${(share * 100).toFixed(1)} % lit, ${nearWhite} near-white px at ${SIZE}x${SIZE})`);
  if (saveDir) {
    mkdirSync(saveDir, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-rtsp_transport', 'tcp', '-i', `${base}/${streamPath}`, '-frames:v', '1', path.join(saveDir, `${streamPath}.png`)], { timeout: 15_000 });
    writeFileSync(path.join(saveDir, `${streamPath}.txt`), black ? 'black\n' : 'face\n');
  }
}
process.exit(failed ? 1 : 0);
