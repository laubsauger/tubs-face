import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// In the built client the face worker never got ready: onnxruntime starts its
// WASM threads as workers of its own module (import.meta.url), and bundled
// into the face worker's chunk each thread loaded the face worker instead.
// Dev was fine, so only the build shows it: onnxruntime must stay a chunk of
// its own that the face worker imports.

describe('the built face worker', () => {
  it('imports onnxruntime from a chunk of its own, not bundled in', () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'tubs-build-'));
    execFileSync(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { stdio: 'pipe' });
    const assets = readdirSync(path.join(out, 'assets'));
    const worker = assets.find((name) => /^face-worker-.*\.js$/.test(name));
    const ort = assets.find((name) => /^ort-.*\.js$/.test(name));
    expect(worker).toBeTruthy();
    expect(ort).toBeTruthy();
    const workerCode = readFileSync(path.join(out, 'assets', worker!), 'utf8');
    expect(workerCode).toContain(`./${ort}`);
    // onnxruntime's own code (its WebGPU/JSEP init) is in its chunk, not the worker's.
    expect(workerCode).not.toContain('jsepInit');
    expect(readFileSync(path.join(out, 'assets', ort!), 'utf8')).toContain('jsepInit');
  }, 120_000);
});
