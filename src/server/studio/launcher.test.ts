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

  // The user found a pile of Tubs windows on their screen. The faces render
  // into their streams wherever the window is, so by default it sits small in
  // the far corner (macOS keeps a corner on screen); never minimised, which
  // stops the drawing. Moved over a pipe, with no network port unless asked.
  it('put the window off screen by default and control it over a pipe, not a port', () => {
    expect(args).toEqual(expect.arrayContaining(['--remote-debugging-pipe', '--window-size=560,600', '--window-position=100000,100000']));
    expect(args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
    const visible = chromeArgs({ url: 'http://x/', profileDir: '/tmp/p/small', slot: 1, windows: 'visible' });
    expect(visible).toEqual(expect.arrayContaining(['--window-size=560,600', '--window-position=620,60']));
    const debug = chromeArgs({ url: 'http://x/', profileDir: '/tmp/p/main', slot: 0, debugPort: 9230 });
    expect(debug).toEqual(expect.arrayContaining(['--remote-debugging-port=9230', '--remote-debugging-address=127.0.0.1']));
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
  // Reopening a crashed page keeps the studio going; reopening forever put
  // window after window on the user's screen. After three exits within a
  // minute it stops and says so loudly in GET /studio.
  it('stops reopening a page that exits three times within a minute, with an error saying so', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-launcher-'));
    const file = path.join(dir, 'chrome.sh');
    writeFileSync(file, `#!/bin/sh\necho start >> "${dir}/starts"\nexit 1\n`);
    chmodSync(file, 0o755);
    const errors: Array<string | undefined> = [];
    const logs: string[] = [];
    launcher = createStudioLauncher({
      chromePath: file,
      profileRoot: path.join(dir, 'profiles'),
      pageUrl: (actor) => `http://page/${actor}`,
      onError: (actor, error) => { if (actor === 'main') errors.push(error); },
      log: (message) => logs.push(message),
      windows: 'visible',
    });
    await launcher.sync(true);
    await until(() => errors.some((error) => error?.includes('not reopening')), 15_000);
    const starts = () => readFileSync(path.join(dir, 'starts'), 'utf8').trim().split('\n').length;
    const after = starts();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(starts()).toBe(after);
    expect(errors.at(-1)).toContain('exited 3 times within a minute');
    expect(logs.some((line) => line.includes('code 1: a crash') && line.includes('reopening'))).toBe(true);
  }, 20_000);

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

// The face's pixel grid is sized from its window: an off-screen window smaller
// than the on-screen one drew a coarse face (four-pixel eyes) into the stream.
describe('off-screen face windows', () => {
  it('are as large as on-screen ones, so the face renders the same', async () => {
    const { windowBounds } = await import('./chrome-window.js');
    const off = windowBounds('offscreen', 0);
    const on = windowBounds('visible', 0);
    expect({ width: off.width, height: off.height }).toEqual({ width: on.width, height: on.height });
  });
});
