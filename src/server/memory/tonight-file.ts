// Tonight's memory across restarts (opt-in: TUBS_TONIGHT_FILE). The server
// was restarted five times on 9 Nov for deploys, and each time the field
// notes, quotes, who had been seen and the auto-onboarding snapshots were
// gone. This is visitor data (notes on people, what they said, a small photo
// of the unnamed), kept on this machine's disk only: put the file under data/
// (never in git). Written atomically, a few seconds after a change, and at
// once when the operator forgets someone or clears tonight; what is older
// than NOTES_TTL_MS is dropped on save and on load.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exportTonight, importTonight, onTonightChange } from '../assistant/field-notes.js';

export const TONIGHT_WRITE_DELAY_MS = 3000;

let timer: NodeJS.Timeout | null = null;
let lastProblem = '';

export function tonightFilePath(): string | null {
  const file = process.env.TUBS_TONIGHT_FILE?.trim();
  return file ? path.resolve(file) : null;
}

function warnOnce(problem: string): void {
  if (problem === lastProblem) return;
  lastProblem = problem;
  console.warn(`[tonight] ${problem}`);
}

/** Writes tonight's memory now, if TUBS_TONIGHT_FILE is set. Never throws. */
export function flushTonight(now = Date.now()): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const file = tonightFilePath();
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...exportTonight(now), savedAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
    renameSync(temp, file);
    lastProblem = '';
  } catch (error) {
    warnOnce(`could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleWrite(urgent: boolean): void {
  if (urgent) {
    flushTonight();
    return;
  }
  timer ??= setTimeout(() => {
    timer = null;
    flushTonight();
  }, TONIGHT_WRITE_DELAY_MS);
}

/** At start: tonight's memory from before the restart, and every change written from now on. Returns how many people came back. */
export function restoreTonight(now = Date.now()): number {
  const file = tonightFilePath();
  if (!file) return 0;
  onTonightChange(scheduleWrite);
  let restored = 0;
  try {
    restored = importTonight(JSON.parse(readFileSync(file, 'utf8')), now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnOnce(`ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (restored > 0) console.log(`[tonight] restored ${restored} people from ${file}`);
  return restored;
}
