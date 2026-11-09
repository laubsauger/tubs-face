// Opens one system Chrome per studio face page, each with its own throwaway
// profile, and closes them again: on disable, on server shutdown, and (from
// the profile's lock file) left over from a server that was killed.

import type { ChildProcess } from 'node:child_process';
import { signalOwned, spawnOwned } from '../processing/owned-process.js';
import { existsSync, mkdirSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STUDIO_ACTORS, type StudioActor } from '../../shared/contracts/studio.js';
import { bringToFront, chromeControl, frontmostApp, windowBounds, type ChromeControl, type StudioWindows } from './chrome-window.js';

export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RESTART_BASE_MS = 2000;
const RESTART_MAX_MS = 30_000;
const QUIT_GRACE_MS = 4000;
/** This many exits within CRASH_WINDOW_MS and a page is not reopened again (a loop of windows helps nobody). */
export const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;

/**
 * Chrome flags for a face page. The page must keep rendering and publishing
 * while its window is behind others, and start audio and the mic with nobody
 * there to click; the profile is its own so it never touches the user's Chrome.
 */
export function chromeArgs(options: { url: string; profileDir: string; slot: number; windows?: StudioWindows; debugPort?: number }): string[] {
  const bounds = windowBounds(options.windows ?? 'offscreen', options.slot);
  return [
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    // A new profile would otherwise ask for the login keychain on macOS.
    '--use-mock-keychain',
    '--password-store=basic',
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    // Grants the mic prompt (the real device is used); nobody is there to click it.
    '--use-fake-ui-for-media-stream',
    // Where its window goes (off screen unless TUBS_STUDIO_WINDOWS=visible); the
    // launcher moves it there over this pipe, since macOS keeps a launch position on screen.
    `--window-size=${bounds.width},${bounds.height}`,
    `--window-position=${bounds.left},${bounds.top}`,
    '--remote-debugging-pipe',
    // TUBS_STUDIO_DEBUG_PORT: the page's console for a person (chrome://inspect), on this machine only.
    ...(options.debugPort ? [`--remote-debugging-port=${options.debugPort}`, '--remote-debugging-address=127.0.0.1'] : []),
    `--app=${options.url}`,
  ];
}

export interface StudioLauncherOptions {
  chromePath: string;
  /** Profiles go in <profileRoot>/<actor>. */
  profileRoot: string;
  pageUrl: (actor: StudioActor) => string;
  /** A page could not be kept running (undefined: it is fine again). */
  onError: (actor: StudioActor, error: string | undefined) => void;
  log?: (message: string) => void;
  /** Off screen (default) or on screen; "Show face windows" changes it live. */
  windows?: StudioWindows;
  /** TUBS_STUDIO_DEBUG_PORT: main's page on this port, small's on the next. */
  debugPort?: number;
}

export interface StudioLauncher {
  /** Brings the pages up (true) or closes them (false). Idempotent. */
  sync(enabled: boolean): Promise<void>;
  /** Closes every page and waits until Chrome has exited. */
  stop(): Promise<void>;
  /** Chrome pids running now, for tests and the log. */
  pids(): number[];
  /** Moves the open pages' windows on screen or off it, and opens later ones the same way. */
  setWindows(mode: StudioWindows): Promise<void>;
  windows(): StudioWindows;
}

interface Page {
  child: ChildProcess | null;
  /** Between deciding to start Chrome and spawning it (a leftover may be closing first). */
  launching: boolean;
  restartTimer: NodeJS.Timeout | null;
  attempt: number;
  startedAt: number;
  control: ChromeControl | null;
  /** When Chrome exited lately (crash loop guard). */
  exits: number[];
}

export function createStudioLauncher(options: StudioLauncherOptions): StudioLauncher {
  const log = options.log ?? ((message: string) => console.log(`[studio] ${message}`));
  const pages = new Map<StudioActor, Page>();
  let wanted = false;
  let windows: StudioWindows = options.windows ?? 'offscreen';

  // A server that exits without its signal handlers (an uncaught error, a
  // plain process.exit) still takes its Chrome windows with it.
  const killOnExit = () => {
    for (const page of pages.values()) {
      if (page.child?.pid && page.child.exitCode === null) {
        signalOwned(page.child, 'SIGKILL');
      }
    }
  };
  process.once('exit', killOnExit);

  function profileDir(actor: StudioActor): string {
    return path.join(options.profileRoot, actor);
  }

  async function launch(actor: StudioActor): Promise<void> {
    const page = pages.get(actor) ?? { child: null, launching: false, restartTimer: null, attempt: 0, startedAt: 0, control: null, exits: [] };
    pages.set(actor, page);
    if (page.child || page.launching || page.restartTimer || !wanted) return;
    if (!existsSync(options.chromePath)) {
      options.onError(actor, `Chrome not found at ${options.chromePath} (set TUBS_STUDIO_CHROME)`);
      return;
    }
    const dir = profileDir(actor);
    mkdirSync(dir, { recursive: true });
    page.launching = true;
    try {
      await closeLeftover(dir, log);
    } finally {
      page.launching = false;
    }
    if (page.child || page.restartTimer || !wanted) return;
    const url = options.pageUrl(actor);
    const slot = STUDIO_ACTORS.indexOf(actor);
    const debugPort = options.debugPort ? options.debugPort + slot : undefined;
    // Opening Chrome takes the focus on macOS: an off-screen page gives it back.
    const front = windows === 'offscreen' ? await frontmostApp() : null;
    // Ends with the server, even a SIGKILLed one (processing/owned-process.ts).
    const child = spawnOwned(options.chromePath, chromeArgs({ url, profileDir: dir, slot, windows, ...(debugPort ? { debugPort } : {}) }), {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    page.child = child;
    page.startedAt = Date.now();
    page.control = chromeControl(child);
    log(`${actor}: Chrome ${child.pid ?? '?'} opening ${url} (window ${windows}${debugPort ? `, DevTools on 127.0.0.1:${debugPort}` : ''})`);
    void placeWindow(actor, page, front);
    options.onError(actor, undefined);
    child.on('error', (error) => {
      options.onError(actor, `Chrome failed to start: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (page.child !== child) return;
      page.child = null;
      page.control?.close();
      page.control = null;
      if (!wanted) return;
      const now = Date.now();
      const reason = signal ? `signal ${signal}` : code === 0 ? 'code 0: quit or closed by hand' : `code ${code}: a crash`;
      page.exits = [...page.exits.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (page.exits.length >= MAX_CRASHES) {
        const error = `Chrome for the ${actor} face exited ${page.exits.length} times within a minute (last: ${reason}); not reopening it. Switch studio mode off and on to try again.`;
        options.onError(actor, error);
        log(`${actor}: ${error}`);
        return;
      }
      // Ran a while: a crash or a closed window, not a broken setup. Start the backoff over.
      if (now - page.startedAt > 60_000) page.attempt = 0;
      const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** page.attempt);
      page.attempt += 1;
      options.onError(actor, `Chrome exited (${reason}); reopening in ${Math.round(delay / 1000)} s`);
      log(`${actor}: Chrome exited (${reason}); reopening in ${delay} ms (exit ${page.exits.length} of ${MAX_CRASHES} allowed within a minute)`);
      page.restartTimer = setTimeout(() => {
        page.restartTimer = null;
        void launch(actor);
      }, delay);
    });
  }

  /** Puts a newly opened page's window where it belongs, then hands the focus back to the app that had it. */
  async function placeWindow(actor: StudioActor, page: Page, front: number | null): Promise<void> {
    const control = page.control;
    if (!control) return;
    try {
      const placed = await control.place(windows, STUDIO_ACTORS.indexOf(actor));
      if (!placed) log(`${actor}: no window to place yet`);
    } catch (error) {
      log(`${actor}: could not place its window (${error instanceof Error ? error.message : String(error)})`);
    }
    if (front !== null && front !== page.child?.pid && windows === 'offscreen' && !(await bringToFront(front))) {
      log(`${actor}: could not give the focus back (allow System Events for this terminal to avoid that)`);
    }
  }

  async function close(actor: StudioActor): Promise<void> {
    const page = pages.get(actor);
    if (!page) return;
    if (page.restartTimer) {
      clearTimeout(page.restartTimer);
      page.restartTimer = null;
    }
    page.attempt = 0;
    page.exits = [];
    const child = page.child;
    page.child = null;
    page.control?.close();
    page.control = null;
    options.onError(actor, undefined);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    log(`${actor}: closing Chrome ${child.pid}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signalOwned(child, 'SIGKILL');
      }, QUIT_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      // Chrome quits cleanly on SIGTERM.
      child.kill('SIGTERM');
    });
  }

  return {
    async sync(enabled) {
      wanted = enabled;
      if (enabled) {
        await Promise.all(STUDIO_ACTORS.map((actor) => launch(actor)));
        return;
      }
      await Promise.all(STUDIO_ACTORS.map((actor) => close(actor)));
    },
    async stop() {
      wanted = false;
      await Promise.all(STUDIO_ACTORS.map((actor) => close(actor)));
      process.removeListener('exit', killOnExit);
    },
    pids() {
      return [...pages.values()].map((page) => page.child?.pid).filter((pid): pid is number => typeof pid === 'number');
    },
    async setWindows(mode) {
      windows = mode;
      await Promise.all(STUDIO_ACTORS.map(async (actor) => {
        const control = pages.get(actor)?.control;
        if (!control) return;
        try {
          await control.place(mode, STUDIO_ACTORS.indexOf(actor));
        } catch (error) {
          log(`${actor}: could not move its window (${error instanceof Error ? error.message : String(error)})`);
        }
      }));
    },
    windows() {
      return windows;
    },
  };
}

/**
 * Chrome keeps "<host>-<pid>" in the profile's SingletonLock link. Only this
 * launcher uses the profile, so a live pid there is a page left behind by a
 * server that was killed (SIGKILL skips every handler): close it, and wait,
 * or the new Chrome would hand its URL to the old one and exit.
 */
async function closeLeftover(profile: string, log: (message: string) => void): Promise<void> {
  let target = '';
  try {
    target = readlinkSync(path.join(profile, 'SingletonLock'));
  } catch {
    return;
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return;
  log(`closing Chrome ${pid} left over in ${profile}`);
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  for (let i = 0; i < 40 && alive(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultProfileRoot(port: number): string {
  return process.env.TUBS_STUDIO_PROFILE_DIR?.trim() || path.join(os.tmpdir(), 'tubs-studio-chrome', String(port));
}
