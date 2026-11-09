// Children that die with the server. Each one gets its own process group
// (so its own children go with it), and a small guard process holds a pipe
// from this server: when the server dies, however it dies (SIGKILL from
// studio-manager included), the pipe closes and the guard ends every group
// still registered. Without it, a killed server left the Python speech
// service, Ming and the studio's Chrome windows running.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** How long the guard waits after SIGTERM before SIGKILL. */
export const GUARD_KILL_GRACE_MS = 2000;

// The guard itself: no files, so it runs the same from src (tsx) and from a build.
const GUARD_SOURCE = `
const groups = new Set();
let buffer = '';
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const [op, id] = buffer.slice(0, at).split(' ');
    buffer = buffer.slice(at + 1);
    const pgid = Number(id);
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    if (op === '+') groups.add(pgid);
    else if (op === '-') groups.delete(pgid);
  }
});
const killAll = (signal) => { for (const pgid of groups) { try { process.kill(-pgid, signal); } catch {} } };
process.stdin.on('end', () => {
  killAll('SIGTERM');
  setTimeout(() => { killAll('SIGKILL'); process.exit(0); }, ${GUARD_KILL_GRACE_MS});
});
`;

let guard: ChildProcess | null = null;

function ensureGuard(): ChildProcess | null {
  if (process.platform === 'win32') return null;
  if (guard && guard.exitCode === null && !guard.killed) return guard;
  // Its own group too, so a signal to the server's group (Ctrl-C) leaves it to do its job.
  guard = spawn(process.execPath, ['-e', GUARD_SOURCE], { stdio: ['pipe', 'ignore', 'inherit'], detached: true });
  guard.unref();
  (guard.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  guard.on('exit', () => {
    guard = null;
  });
  return guard;
}

/**
 * spawn(), but the child (and everything it starts) ends with this server.
 * Stop it with stopOwned().
 */
export function spawnOwned(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const windows = process.platform === 'win32';
  const child = spawn(command, args, { ...options, detached: !windows });
  const pid = child.pid;
  if (pid && !windows) {
    ensureGuard()?.stdin?.write(`+ ${pid}\n`);
    child.once('exit', () => {
      guard?.stdin?.write(`- ${pid}\n`);
    });
  }
  return child;
}

/** A signal to the child's whole group (the child and what it started). */
export function signalOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* gone */ }
  }
}
