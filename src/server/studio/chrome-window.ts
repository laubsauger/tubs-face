// Where a launched face page's window sits, over the Chrome DevTools protocol
// on the pipe Chrome opens with --remote-debugging-pipe (fds 3 and 4 of the
// child; no network port). Off screen by default (TUBS_STUDIO_WINDOWS): macOS
// keeps a corner of every window on a screen, so the window is made small and
// pushed into the far corner. Never minimised: a minimised window's page is
// hidden and stops drawing (requestAnimationFrame stops), so its stream would
// freeze. "Show face windows" in the Studio tab brings them back.

import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export type StudioWindows = 'offscreen' | 'visible';

const VISIBLE = { width: 560, height: 600, gap: 20, left: 40, top: 60 };
// Same size as on screen: the face's pixel grid is sized from the window, so a
// small off-screen window drew four-pixel eyes into the 1024 px stream.
const OFFSCREEN = { width: VISIBLE.width, height: VISIBLE.height, far: 100_000 };
const CALL_TIMEOUT_MS = 5000;
const PAGE_WAIT_MS = 10_000;

export function windowsModeFrom(value: string | undefined): StudioWindows {
  return value?.trim() === 'visible' ? 'visible' : 'offscreen';
}

/** Window bounds for a head's page: its slot on screen, or the far corner, small. */
export function windowBounds(mode: StudioWindows, slot: number): { left: number; top: number; width: number; height: number } {
  return mode === 'visible'
    ? { left: VISIBLE.left + slot * (VISIBLE.width + VISIBLE.gap), top: VISIBLE.top, width: VISIBLE.width, height: VISIBLE.height }
    : { left: OFFSCREEN.far, top: OFFSCREEN.far, width: OFFSCREEN.width, height: OFFSCREEN.height };
}

export interface ChromeControl {
  /** Puts the page's window on screen or in the far corner; false when it has no window (yet). */
  place(mode: StudioWindows, slot: number): Promise<boolean>;
  close(): void;
}

/** The DevTools protocol on a child started with stdio [.., .., .., 'pipe', 'pipe'] and --remote-debugging-pipe. */
export function chromeControl(child: ChildProcess): ChromeControl | null {
  const input = child.stdio[3] as Writable | null | undefined;
  const output = child.stdio[4] as Readable | null | undefined;
  if (!input || !output) return null;
  let nextId = 0;
  let buffer = '';
  let closed = false;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf('\0');
    while (end >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\0');
      try {
        const message = JSON.parse(raw) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        const call = message.id !== undefined ? pending.get(message.id) : undefined;
        if (!call) continue;
        pending.delete(message.id!);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(message.error.message ?? 'DevTools error'));
        else call.resolve(message.result ?? {});
      } catch {
        // Not ours to read: events, or a half message (the rest comes with the next chunk).
      }
    }
  });
  // A Chrome that quits closes the pipe: nothing waits on it after that.
  const fail = () => {
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Chrome is gone'));
    }
    pending.clear();
  };
  output.on('close', fail);
  output.on('error', fail);
  input.on('error', fail);

  const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (closed) return Promise.reject(new Error('Chrome is gone'));
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      input.write(`${JSON.stringify({ id, method, params })}\0`);
    });
  };

  async function pageWindow(): Promise<number | null> {
    const started = Date.now();
    while (Date.now() - started < PAGE_WAIT_MS && !closed) {
      const { targetInfos } = await send('Target.getTargets') as { targetInfos?: Array<{ targetId: string; type: string }> };
      const page = targetInfos?.find((target) => target.type === 'page');
      if (page) {
        const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.targetId }) as { windowId?: number };
        if (typeof windowId === 'number') return windowId;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  return {
    async place(mode, slot) {
      const windowId = await pageWindow();
      if (windowId === null) return false;
      // Out of minimised or maximised first: bounds apply to a normal window only.
      await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await send('Browser.setWindowBounds', { windowId, bounds: windowBounds(mode, slot) });
      return true;
    },
    close() {
      fail();
      input.end();
    },
  };
}

/** macOS: the app in front now (its pid), so a page opened off screen can hand the focus back. */
export function frontmostApp(): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "System Events" to get unix id of first application process whose frontmost is true'], { timeout: 2000 }, (error, stdout) => {
      const pid = Number(String(stdout).trim());
      resolve(error || !Number.isInteger(pid) ? null : pid);
    });
  });
}

/** macOS: puts that app in front again; false when macOS would not (no permission for System Events). */
export function bringToFront(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application "System Events" to set frontmost of (first application process whose unix id is ${Math.trunc(pid)}) to true`], { timeout: 2000 }, (error) => resolve(!error));
  });
}
