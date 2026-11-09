import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// studio-manager stops a service, and may have to SIGKILL it. A killed
// tubs-face used to leave its Python speech service, Ming and the studio's
// Chrome windows running, holding ports and the GPU. Whatever it started must
// go with it, grandchildren included.

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('children of a killed server', () => {
  it('do not outlive it, nor do their own children', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-owned-'));
    const parentScript = path.join(dir, 'parent.mts');
    // A stand-in server: two owned children, one of which starts a grandchild.
    writeFileSync(parentScript, `
      const { spawnOwned } = await import(${JSON.stringify(path.resolve('src/server/processing/owned-process.ts'))});
      const a = spawnOwned('sh', ['-c', 'sleep 60 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const b = spawnOwned('sleep', ['60'], { stdio: 'ignore' });
      a.stdout.once('data', (data) => console.log(JSON.stringify({ child: a.pid, grandchild: Number(String(data).trim()), other: b.pid })));
      setInterval(() => {}, 1000);
    `);
    const parent = spawn(path.resolve('node_modules/.bin/tsx'), [parentScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    const pids = await new Promise<{ child: number; grandchild: number; other: number }>((resolve, reject) => {
      parent.stdout.once('data', (data) => resolve(JSON.parse(String(data).trim().split('\n').at(-1)!)));
      setTimeout(() => reject(new Error('the stand-in server did not start')), 10_000);
    });
    expect([pids.child, pids.grandchild, pids.other].every(alive)).toBe(true);

    // tsx runs the script in a child node; kill that one, the real "server".
    const server = Number((await new Promise<string>((resolve) => {
      const ps = spawn('pgrep', ['-P', String(parent.pid)]);
      let out = '';
      ps.stdout.on('data', (data) => { out += String(data); });
      ps.on('close', () => resolve(out.trim().split('\n')[0] ?? ''));
    })) || parent.pid);
    process.kill(server, 'SIGKILL');
    try { process.kill(parent.pid!, 'SIGKILL'); } catch { /* gone with it */ }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && [pids.child, pids.grandchild, pids.other].some(alive)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect({ child: alive(pids.child), grandchild: alive(pids.grandchild), other: alive(pids.other) }).toEqual({ child: false, grandchild: false, other: false });
  }, 20_000);
});
