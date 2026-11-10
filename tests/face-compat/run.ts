// Do the face service and the browser worker agree? (docs/face-service.md)
//
// The face library's embeddings came from the browser worker, so the service
// must produce the same ones. This runs both on the same pictures, pixel for
// pixel: the browser worker in headless Chrome (harness.html, through Vite on
// a free port, the models served from the service's cache instead of
// huggingface), and the face service (src/face-service.py, on a free port,
// once per backend). For every face it reports the cosine between the two
// embeddings and whether the library decisions agree, and it writes the
// browser's embeddings to tests/fixtures/faces/browser-embeddings.json for
// tests/python/test_face_pipeline.py.
//
//   npx tsx tests/face-compat/run.ts [--out <dir>] [--backends cpu,coreml]
//
// Pictures: tests/fixtures/faces/*.jpg, public domain official photographs from
// Wikimedia Commons, scaled down: President_Barack_Obama.jpg (obama-2012),
// Official_portrait_of_Barack_Obama.jpg (obama-2009), Joe_Biden_presidential_portrait.jpg,
// Kamala_Harris_Vice_Presidential_Portrait.jpg (White House) and Apollo_11_Crew.jpg (NASA).
// Never the library's people.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { annotateDetectedFaces, cosineSimilarity } from '../../src/client/face/matching.js';
import type { DetectedFace, EnrolledFace } from '../../src/shared/contracts/faces.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/faces');
const MODEL_DIR = process.env.FACE_MODEL_DIR || path.join(os.homedir(), '.cache/tubs-face/models');
const PYTHON = path.join(ROOT, 'venv/bin/python');
const args = process.argv.slice(2);
const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]!) : null;
const backends = (args.includes('--backends') ? args[args.indexOf('--backends') + 1]! : 'cpu,coreml').split(',');
/** Who is in the test library, from which picture (the browser's embedding of it). */
const LIBRARY: Record<string, string> = { Obama: 'obama-2012.jpg', Biden: 'biden-2021.jpg', Harris: 'harris-2021.jpg' };

interface Face { box: number[]; score: number; landmarks: number[][] | null; embedding: number[] | null }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startService(backend: string): Promise<{ base: string; child: ChildProcess; health: Record<string, unknown> }> {
  const port = await freePort();
  const child = spawn(PYTHON, ['-I', path.join(ROOT, 'src/face-service.py'), '--port', String(port)], {
    env: { ...process.env, FACE_SERVICE_BACKEND: backend, FACE_MODEL_DIR: MODEL_DIR },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      if (health.state === 'ready') return { base, child, health };
      if (health.state === 'error') throw new Error(`service (${backend}): ${String(health.error)}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('service')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`service (${backend}) did not get ready`);
}

const iou = (a: number[], b: number[]) => {
  const w = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
  const h = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = w * h;
  return inter / ((a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - inter);
};

function decision(face: Face, library: EnrolledFace[]): string {
  const [annotated] = annotateDetectedFaces([{ box: face.box as DetectedFace['box'], score: face.score, embedding: face.embedding }], library);
  return annotated?.name ?? 'unknown';
}

async function main(): Promise<void> {
  for (const file of ['det_10g.onnx', 'w600k_r50.onnx']) {
    if (!existsSync(path.join(MODEL_DIR, file))) throw new Error(`${file} is not in ${MODEL_DIR}: start the face service once to download it`);
  }
  const images = readdirSync(FIXTURES).filter((file) => file.endsWith('.jpg')).sort();
  const services = await Promise.all(backends.map(async (backend) => ({ backend, ...(await startService(backend)) })));
  const vitePort = await freePort();
  const vite = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    // node_modules may be a link to another checkout's (a worktree): onnxruntime-web's wasm is read from there.
    server: { port: vitePort, strictPort: true, host: '127.0.0.1', hmr: false, fs: { allow: [ROOT, realpathSync(path.join(ROOT, 'node_modules'))] } },
  });
  await vite.listen();
  const models = await serveModels();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    // The worker fetches its models from huggingface; it gets the very same files from the
    // cache instead, by a redirect to a local server (fulfilling 174 MB over CDP takes Chrome down).
    await context.route(/huggingface\.co\/.+\/(det_10g|w600k_r50)\.onnx$/, (route) => {
      const file = path.basename(new URL(route.request().url()).pathname);
      void route.fulfill({ status: 302, headers: { Location: `${models.base}/${file}`, 'Access-Control-Allow-Origin': '*' } });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error('[harness]', error.message));
    page.on('crash', () => console.error('[harness] the page crashed'));
    page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') console.error('[harness console]', message.text()); });
    await page.goto(`http://127.0.0.1:${vitePort}/tests/face-compat/harness.html`);
    await page.waitForFunction(() => Boolean(window.faceHarness), undefined, { timeout: 60_000 });
    await page.evaluate(() => window.faceHarness.ready);
    const chromeVersion = browser.version();

    const browserFaces: Record<string, { width: number; height: number; faces: Face[] }> = {};
    const serviceFaces: Record<string, Record<string, Face[]>> = {};
    for (const image of images) {
      const file = path.join(FIXTURES, image);
      const decoded = JSON.parse(execFileSync(PYTHON, ['-I', path.join(ROOT, 'tests/face-compat/decode.py'), file], { maxBuffer: 64 << 20 }).toString()) as { width: number; height: number; rgba: string };
      const result = await page.evaluate(({ rgba, width, height }) => window.faceHarness.detect(rgba, width, height), decoded) as { faces: Face[] };
      browserFaces[image] = { width: decoded.width, height: decoded.height, faces: result.faces.map(({ box, score, landmarks, embedding }) => ({ box, score, landmarks: landmarks ?? null, embedding: embedding ?? null })) };
      for (const service of services) {
        const response = await fetch(`${service.base}/detect`, { method: 'POST', body: readFileSync(file) });
        const body = await response.json() as { faces: Face[] };
        (serviceFaces[service.backend] ??= {})[image] = body.faces;
      }
    }

    const library: EnrolledFace[] = Object.entries(LIBRARY).map(([name, image], index) => {
      const faces = browserFaces[image]!.faces;
      if (faces.length !== 1 || !faces[0]!.embedding) throw new Error(`${image}: expected one face, the browser found ${faces.length}`);
      return { id: `test-${index}`, name, embedding: faces[0]!.embedding };
    });

    const rows: Array<Record<string, unknown>> = [];
    for (const image of images) {
      const reference = browserFaces[image]!.faces;
      for (const [index, face] of reference.entries()) {
        const row: Record<string, unknown> = { image, face: index, browserScore: round(face.score, 4), browserDecision: decision(face, library) };
        for (const service of services) {
          const candidates = serviceFaces[service.backend]![image]!;
          const twin = candidates.map((candidate) => ({ candidate, overlap: iou(face.box, candidate.box) })).sort((a, b) => b.overlap - a.overlap)[0];
          if (!twin || twin.overlap < 0.5 || !twin.candidate.embedding || !face.embedding) {
            row[`${service.backend}Cosine`] = null;
            continue;
          }
          const other = twin.candidate;
          const landmarkPx = face.landmarks && other.landmarks
            ? Math.max(...face.landmarks.map((point, k) => Math.hypot(point[0]! - other.landmarks![k]![0]!, point[1]! - other.landmarks![k]![1]!)))
            : null;
          row[`${service.backend}Cosine`] = round(cosineSimilarity(face.embedding, other.embedding!), 5);
          row[`${service.backend}ScoreDiff`] = round(Math.abs(face.score - other.score), 5);
          row[`${service.backend}LandmarkPx`] = landmarkPx === null ? null : round(landmarkPx, 3);
          row[`${service.backend}Decision`] = decision(other, library);
        }
        rows.push(row);
      }
      for (const service of services) {
        const extra = serviceFaces[service.backend]![image]!.length - reference.length;
        if (extra !== 0) rows.push({ image, note: `${service.backend} found ${extra > 0 ? `${extra} more` : `${-extra} fewer`} faces than the browser` });
      }
    }

    console.table(rows);
    const summary = Object.fromEntries(services.map((service) => {
      const cosines = rows.map((row) => row[`${service.backend}Cosine`]).filter((value): value is number => typeof value === 'number');
      const agree = rows.filter((row) => row.browserDecision !== undefined && row[`${service.backend}Decision`] === row.browserDecision).length;
      return [service.backend, {
        backend: service.health.backend,
        faces: cosines.length,
        minCosine: Math.min(...cosines),
        meanCosine: round(cosines.reduce((sum, value) => sum + value, 0) / cosines.length, 5),
        decisionsAgree: `${agree}/${rows.filter((row) => row.browserDecision !== undefined).length}`,
      }];
    }));
    console.log(JSON.stringify({ chrome: chromeVersion, summary }, null, 2));

    const roundFace = (face: Face) => ({
      box: face.box.map((value) => round(value, 3)),
      score: round(face.score, 6),
      landmarks: face.landmarks?.map((point) => point.map((value) => round(value, 3))) ?? null,
      embedding: face.embedding?.map((value) => round(value, 7)) ?? null,
    });
    writeFileSync(path.join(FIXTURES, 'browser-embeddings.json'), `${JSON.stringify({
      about: 'The browser face worker (src/workers/face-worker.ts) on these pictures, written by tests/face-compat/run.ts; the face service must agree (tests/python/test_face_pipeline.py).',
      chrome: chromeVersion,
      library: LIBRARY,
      images: Object.fromEntries(Object.entries(browserFaces).map(([image, value]) => [image, { width: value.width, height: value.height, faces: value.faces.map(roundFace) }])),
    })}\n`);
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'compat.json'), `${JSON.stringify({ chrome: chromeVersion, summary, rows }, null, 2)}\n`);
    }
  } finally {
    await browser.close();
    await vite.close();
    models.server.close();
    for (const service of services) service.child.kill('SIGTERM');
  }
}

/** The model files on a local port, for the harness page. */
async function serveModels(): Promise<{ base: string; server: http.Server }> {
  const server = http.createServer((request, response) => {
    const name = path.basename(request.url ?? '');
    if (!['det_10g.onnx', 'w600k_r50.onnx'].includes(name)) {
      response.writeHead(404).end();
      return;
    }
    const file = path.join(MODEL_DIR, name);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(file).size, 'Access-Control-Allow-Origin': '*' });
    createReadStream(file).pipe(response);
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${port}`, server };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
