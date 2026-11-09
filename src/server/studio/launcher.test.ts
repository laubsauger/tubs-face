import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromeArgs, createStudioLauncher, type StudioLauncher } from './launcher.js';

// Studio mode opens a Chrome per face. Those windows must come up when it is
// switched on, go away when it is switched off or the server stops, and never
// be left running on the studio machine (they would keep publishing a frozen
// face and hold the mic).

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A stand-in for Chrome: notes its arguments and waits to be closed. */
function fakeChrome(dir: string): string {
  const file = path.join(dir, 'chrome.sh');
  writeFileSync(file, `#!/bin/sh\necho "$@" > "${dir}/args.$$"\nexec sleep 600\n`);
  chmodSync(file, 0o755);
  return file;
}

let launcher: StudioLauncher | null = null;
afterEach(async () => {
  await launcher?.stop();
  launcher = null;
});

describe('Chrome flags for a face page', () => {
  const args = chromeArgs({ url: 'http://127.0.0.1:3000/studio-face.html?actor=main', profileDir: '/tmp/p/main', slot: 0 });

  it('keep the page rendering and publishing behind other windows', () => {
    expect(args).toEqual(expect.arrayContaining([
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ]));
  });

  it('start sound and the mic with nobody there to click', () => {
    expect(args).toEqual(expect.arrayContaining(['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream']));
  });

  it('use their own profile, never the user\'s Chrome', () => {
    expect(args).toContain('--user-data-dir=/tmp/p/main');
    expect(args.at(-1)).toBe('--app=http://127.0.0.1:3000/studio-face.html?actor=main');
  });
});

describe('studio launcher', () => {
  it('opens a page per head on enable and closes them all on disable', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-launcher-'));
    launcher = createStudioLauncher({
      chromePath: fakeChrome(dir),
      profileRoot: path.join(dir, 'profiles'),
      pageUrl: (actor) => `http://page/${actor}`,
      onError: () => {},
      log: () => {},
    });
    await launcher.sync(true);
    await until(() => launcher!.pids().length === 2);
    const pids = launcher.pids();
    expect(pids.every(alive)).toBe(true);
    await until(() => readdirSync(dir).filter((name) => name.startsWith('args.')).length === 2);
    const argLines = readdirSync(dir).filter((name) => name.startsWith('args.')).map((name) => readFileSync(path.join(dir, name), 'utf8'));
    expect(argLines.some((line) => line.includes('--app=http://page/main') && line.includes(`--user-data-dir=${path.join(dir, 'profiles', 'main')}`))).toBe(true);
    expect(argLines.some((line) => line.includes('--app=http://page/small') && line.includes(`--user-data-dir=${path.join(dir, 'profiles', 'small')}`))).toBe(true);

    // Enabling again does not open a second pair.
    await launcher.sync(true);
    expect(launcher.pids()).toEqual(pids);

    await launcher.sync(false);
    expect(launcher.pids()).toEqual([]);
    expect(pids.some(alive)).toBe(false);
  });

  it('closes the pages when the server stops', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-launcher-'));
    launcher = createStudioLauncher({ chromePath: fakeChrome(dir), profileRoot: path.join(dir, 'profiles'), pageUrl: (a) => a, onError: () => {}, log: () => {} });
    await launcher.sync(true);
    await until(() => launcher!.pids().length === 2);
    const pids = launcher.pids();
    await launcher.stop();
    expect(pids.some(alive)).toBe(false);
  });

  it('reopens a page whose Chrome died while studio mode is on, and says so meanwhile', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-launcher-'));
    const errors: Array<[string, string | undefined]> = [];
    launcher = createStudioLauncher({
      chromePath: fakeChrome(dir),
      profileRoot: path.join(dir, 'profiles'),
      pageUrl: (a) => a,
      onError: (actor, error) => errors.push([actor, error]),
      log: () => {},
    });
    await launcher.sync(true);
    await until(() => launcher!.pids().length === 2);
    const [first] = launcher.pids();
    process.kill(first!, 'SIGKILL');
    await until(() => errors.some(([, error]) => error?.startsWith('Chrome exited')));
    await until(() => launcher!.pids().length === 2 && !launcher!.pids().includes(first!), 6000);
  }, 10_000);

  // A server killed with SIGKILL runs no handler. Its pages must not live on
  // next to the new ones: Chrome's profile lock names the leftover.
  it('closes a page left over by a killed server before opening a new one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-launcher-'));
    const profiles = path.join(dir, 'profiles');
    mkdirSync(path.join(profiles, 'main'), { recursive: true });
    const leftover = spawn('sleep', ['600'], { stdio: 'ignore' });
    symlinkSync(`${os.hostname()}-${leftover.pid}`, path.join(profiles, 'main', 'SingletonLock'));
    launcher = createStudioLauncher({ chromePath: fakeChrome(dir), profileRoot: profiles, pageUrl: (a) => a, onError: () => {}, log: () => {} });
    await launcher.sync(true);
    await until(() => !alive(leftover.pid!));
    await until(() => launcher!.pids().length === 2);
  });

  it('reports a missing Chrome instead of failing silently', async () => {
    const errors: string[] = [];
    launcher = createStudioLauncher({
      chromePath: '/nonexistent/Google Chrome',
      profileRoot: mkdtempSync(path.join(os.tmpdir(), 'tubs-launcher-')),
      pageUrl: (a) => a,
      onError: (_actor, error) => { if (error) errors.push(error); },
      log: () => {},
    });
    await launcher.sync(true);
    expect(errors).toEqual([expect.stringContaining('Chrome not found'), expect.stringContaining('Chrome not found')]);
  });
});
