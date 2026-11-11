// The scene's listening (sentient-studio contract §6, studio_context `listen`): whether the studio waits
// for "hey Tubs", and tonight's extra names that call the heads too. Asked for: switch between always
// answering and answering only when called, by scene or from the dashboard. A scene that changes its
// listening sets the wake-word switch; a change on the dashboard holds until the next scene change.
// The names always follow the scene.

import { studioSettings } from './state.js';

/** the last scene's wake setting, to tell a scene change from the same scene sent again */
let lastWake: boolean | null = null;

export interface SceneListen { wake: boolean; names?: string[] }

/** a studio_context's `listen`, checked: null when absent or malformed */
export function parseListen(value: unknown): SceneListen | null {
  const v = value as { wake?: unknown; names?: unknown } | null;
  if (!v || typeof v !== 'object' || typeof v.wake !== 'boolean') return null;
  const names = Array.isArray(v.names) ? v.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim().slice(0, 24)).slice(0, 8) : [];
  return { wake: v.wake, names };
}

/**
 * The director's scene says how to listen: keeps its names, and returns the wake setting when the
 * scene changed it (for the switch), null when nothing changes.
 */
export function noteSceneListen(value: unknown): boolean | null {
  const listen = parseListen(value);
  if (!listen) return null;
  studioSettings.wakeNames = listen.names ?? [];
  if (listen.wake === lastWake) return null;
  lastWake = listen.wake;
  return listen.wake === studioSettings.wakeWord ? null : listen.wake;
}

/** Test helper. */
export function resetSceneListen(): void {
  lastWake = null;
  studioSettings.wakeNames = [];
}
