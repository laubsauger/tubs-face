// Studio choices that survive a restart (opt-in: TUBS_STATE_FILE). On a studio
// Mac, studio-manager restarts tubs-face whenever it needs to; the night's
// character, the relationships toggle, who looks at the pictures, where the
// mic and the pictures come from and what each head wears should come back as
// the operator left them.
// A local file, never in git (put it under data/), written whenever one of
// these changes and read once at start. Never any key or password.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyRuntimeConfigPatch, runtimeConfig } from './config/runtime.js';
import { applyPreset, listPresets } from './presets/presets.js';
import { applyStudioPatch, studioSettings } from './studio/state.js';

export interface PersistedState {
  /** The character preset applied last. */
  preset?: string | null;
  relationshipsEnabled?: boolean;
  visionProvider?: string;
  visionModel?: string;
  visionBaseUrl?: string;
  visionSource?: string;
  micSource?: string;
  propMain?: string;
  propSmall?: string;
  /** The switches (StudioSwitches) that are not already above. */
  visionDescriptions?: boolean;
  cameraOn?: boolean;
  micOn?: boolean;
  faceRecognition?: boolean;
  wakeWord?: boolean;
  savedAt?: string;
}

export function stateFilePath(): string | null {
  const file = process.env.TUBS_STATE_FILE?.trim();
  return file ? path.resolve(file) : null;
}

export function snapshotState(): PersistedState {
  return {
    preset: listPresets().active,
    relationshipsEnabled: runtimeConfig.relationshipsEnabled,
    visionProvider: runtimeConfig.visionProvider,
    visionModel: runtimeConfig.visionModel,
    visionBaseUrl: runtimeConfig.visionBaseUrl,
    visionSource: studioSettings.visionSource,
    micSource: studioSettings.micSource,
    propMain: runtimeConfig.propMain,
    propSmall: runtimeConfig.propSmall,
    visionDescriptions: runtimeConfig.visionDescriptions,
    cameraOn: studioSettings.cameraOn,
    micOn: studioSettings.micOn,
    faceRecognition: studioSettings.faceRecognition,
    wakeWord: studioSettings.wakeWord,
  };
}

let lastProblem = '';
function warnOnce(problem: string): void {
  if (problem === lastProblem) return;
  lastProblem = problem;
  console.warn(`[state] ${problem}`);
}

/** Writes the current choices, if TUBS_STATE_FILE is set. Never throws. */
export function persistState(): void {
  const file = stateFilePath();
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...snapshotState(), savedAt: new Date().toISOString() }, null, 2)}\n`);
    renameSync(temp, file);
    lastProblem = '';
  } catch (error) {
    warnOnce(`could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * At start: the saved choices on top of env and defaults. Each part on its own:
 * a preset that is gone or a value no longer valid is skipped, with a warning.
 */
export function restoreState(): string[] {
  const file = stateFilePath();
  if (!file) return [];
  let saved: PersistedState;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8')) as PersistedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnOnce(`ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const restored: string[] = [];
  const attempt = (what: string, apply: () => void) => {
    try {
      apply();
      restored.push(what);
    } catch (error) {
      console.warn(`[state] not restoring ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // The preset first: the toggles, vision choices and props saved with it win over it.
  if (typeof saved.preset === 'string' && saved.preset) attempt(`preset ${saved.preset}`, () => applyPreset(saved.preset!));
  const config: Record<string, unknown> = {};
  for (const key of ['relationshipsEnabled', 'visionProvider', 'visionModel', 'visionBaseUrl', 'propMain', 'propSmall', 'visionDescriptions'] as const) {
    if (saved[key] !== undefined) config[key] = saved[key];
  }
  // Vision descriptions are paid per picture with every provider there is (gemini, openai): a session
  // never starts with them on, whatever was saved; they are switched on in the Studio tab when wanted.
  // Seen 11 Nov 2026: left on (and restored at every start) they ate the budget.
  if (config.visionDescriptions === true) {
    delete config.visionDescriptions;
    console.log('[state] vision descriptions start off (paid per picture); switch them on in the Studio tab when wanted');
  }
  for (const [key, value] of Object.entries(config)) attempt(key, () => applyRuntimeConfigPatch({ [key]: value }));
  for (const key of ['micSource', 'visionSource'] as const) {
    if (typeof saved[key] === 'string') attempt(key, () => applyStudioPatch({ [key]: saved[key] }));
  }
  const switches = { camera: saved.cameraOn, mic: saved.micOn, faceRecognition: saved.faceRecognition, wakeWord: saved.wakeWord };
  for (const [key, on] of Object.entries(switches)) {
    if (on !== undefined) attempt(`switch ${key}`, () => applyStudioPatch({ switches: { [key]: on } }));
  }
  if (restored.length > 0) console.log(`[state] restored from ${file}: ${restored.join(', ')}`);
  return restored;
}
