// Character presets ("profiles"): a night may not always be Tubs with this
// personality. A preset is a named snapshot of who the characters are
// (persona template, extra instruction, canned lines, running bits), how they
// sound (a voice per head), how they look (glitch colours, shapes, FX,
// expression profiles) and how they behave (sleep timing, interruptible,
// two-head mode). Stored as readable JSON in config/presets/<name>.json
// (TUBS_CONFIG_DIR), so presets can live in git. Applying one is safe
// mid-show: it changes the live config and the persona in place, all or
// nothing, without a restart; the face pages keep publishing and pick the look
// up from the config broadcast.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GreetingsConfig } from '../../shared/contracts/faces.js';
import type { RuntimeConfig } from '../../shared/contracts/config.js';
import type { PresetFile, PresetSummary } from '../../shared/contracts/presets.js';
import type { RunningBit } from '../../shared/contracts/bits.js';
import { configDir } from '../assistant/relationships.js';
import { activeBits, parseBits, setPresetBits } from '../assistant/bits.js';
import { applyRuntimeConfigPatch, runtimeConfig, type RuntimeConfigPatch } from '../config/runtime.js';
import { personaOverride, setPersonaOverride } from '../persona/index.js';

/** Behaviour: what the characters do, as opposed to how they look or sound. */
export const PRESET_BEHAVIOUR_KEYS = ['sleepTimeout', 'interruptible', 'dualHeadEnabled', 'dualHeadMode', 'dualHeadTurnPolicy'] as const satisfies ReadonlyArray<keyof RuntimeConfig>;

/** Look: every glitch setting (colours, shapes, FX, expression profiles) and Small's colour. */
export function lookKeys(): Array<keyof RuntimeConfig> {
  return (Object.keys(runtimeConfig) as Array<keyof RuntimeConfig>).filter((key) => key.startsWith('glitch') || key === 'secondaryGlitchFxBaseColor');
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

export class PresetError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
    this.name = 'PresetError';
  }
}

export function presetsDir(): string {
  return path.join(configDir(), 'presets');
}

/** "Night Two" -> night-two.json; anything else is refused before it touches the disk. */
export function presetFile(name: string): string {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!NAME_RE.test(clean)) throw new PresetError('A preset name is 1-40 letters, digits, spaces, - or _', 400);
  return path.join(presetsDir(), `${clean.toLowerCase().replace(/[\s_]+/g, '-')}.json`);
}

let active: string | null = null;

export function listPresets(): { presets: PresetSummary[]; active: string | null } {
  const dir = presetsDir();
  const presets: PresetSummary[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as Partial<PresetFile>;
        if (typeof parsed.name === 'string') presets.push({ name: parsed.name, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null });
      } catch {
        // A broken file is skipped here and refused on apply.
      }
    }
  }
  return { presets, active };
}

function readPreset(name: string): PresetFile {
  const file = presetFile(name);
  if (!existsSync(file)) throw new PresetError(`No preset called ${name.trim()}`, 404);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PresetError(`${path.basename(file)} is not valid JSON (${error instanceof Error ? error.message : String(error)})`, 400);
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as PresetFile).name !== 'string') {
    throw new PresetError(`${path.basename(file)} is not a preset`, 400);
  }
  return parsed as PresetFile;
}

/** The persona template: inline, from a file next to the preset, or null for the built-in one. */
function systemPromptOf(preset: PresetFile): string | null {
  const persona = preset.persona ?? {};
  if (typeof persona.systemPrompt === 'string' && persona.systemPrompt.trim()) return persona.systemPrompt;
  if (typeof persona.systemPromptFile === 'string' && persona.systemPromptFile.trim()) {
    const dir = presetsDir();
    const file = path.resolve(dir, persona.systemPromptFile);
    if (!file.startsWith(dir + path.sep)) throw new PresetError('persona.systemPromptFile must be inside the presets folder', 400);
    if (!existsSync(file)) throw new PresetError(`persona.systemPromptFile ${persona.systemPromptFile} not found`, 400);
    return readFileSync(file, 'utf8');
  }
  return null;
}

function patchOf(preset: PresetFile): RuntimeConfigPatch {
  const patch: Record<string, unknown> = {};
  const look = new Set<string>(lookKeys());
  for (const [key, value] of Object.entries(preset.look ?? {})) {
    if (!look.has(key)) throw new PresetError(`look.${key} is not a look setting`, 400);
    patch[key] = value;
  }
  for (const [key, value] of Object.entries(preset.behaviour ?? {})) {
    if (!(PRESET_BEHAVIOUR_KEYS as readonly string[]).includes(key)) throw new PresetError(`behaviour.${key} is not a behaviour setting`, 400);
    patch[key] = value;
  }
  if (preset.voices?.main !== undefined) patch.kokoroVoice = preset.voices.main;
  if (preset.voices?.small !== undefined) patch.secondaryVoice = preset.voices.small;
  if (preset.persona?.instruction !== undefined) patch.prompt = preset.persona.instruction;
  return patch as RuntimeConfigPatch;
}

/** The preset's running bits, or null for the built-in ones (tubs.json's). */
function bitsOf(preset: PresetFile): RunningBit[] | null {
  if (preset.bits === undefined) return null;
  try {
    return parseBits(preset.bits);
  } catch (error) {
    throw new PresetError(`${preset.name}: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
}

/**
 * Applies a preset live, all or nothing: an unknown name or any bad value
 * leaves the config and the persona exactly as they were.
 */
export function applyPreset(name: string): PresetFile {
  const preset = readPreset(name);
  const systemPrompt = systemPromptOf(preset);
  const greetings = (preset.lines ?? null) as GreetingsConfig | null;
  const bits = bitsOf(preset);
  const patch = patchOf(preset);
  const before = structuredClone(runtimeConfig);
  try {
    applyRuntimeConfigPatch(patch);
  } catch (error) {
    Object.assign(runtimeConfig, before);
    throw new PresetError(`${preset.name}: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  setPersonaOverride({ systemPrompt, greetings });
  setPresetBits(bits);
  active = preset.name;
  console.log(`[presets] applied ${preset.name}`);
  return preset;
}

/** The characters as they are now, under this name. */
export function savePreset(name: string, now = new Date()): PresetFile {
  const file = presetFile(name);
  const override = personaOverride();
  const pick = (keys: ReadonlyArray<keyof RuntimeConfig>) => Object.fromEntries(keys.map((key) => [key, structuredClone(runtimeConfig[key])]));
  const preset: PresetFile = {
    name: name.trim(),
    savedAt: now.toISOString(),
    // No systemPrompt: the built-in persona (src/persona/system-prompt.md).
    persona: { ...(override.systemPrompt ? { systemPrompt: override.systemPrompt } : {}), instruction: runtimeConfig.prompt },
    ...(override.greetings ? { lines: override.greetings } : {}),
    // Always written, even the built-in ones: those live in tubs.json, and
    // saving over "Tubs" from the dashboard must not drop them.
    bits: structuredClone(activeBits()),
    voices: { main: runtimeConfig.kokoroVoice, small: runtimeConfig.secondaryVoice },
    look: pick(lookKeys()),
    behaviour: pick(PRESET_BEHAVIOUR_KEYS),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(preset, null, 2)}\n`);
  active = preset.name;
  console.log(`[presets] saved ${preset.name} to ${file}`);
  return preset;
}

/** Test helper: no preset applied, the built-in persona. */
export function resetPresets(): void {
  active = null;
  setPersonaOverride({ systemPrompt: null, greetings: null });
  setPresetBits(null);
}
