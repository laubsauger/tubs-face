// Character presets (server/presets/presets.ts): config/presets/<name>.json.

import type { GreetingsConfig } from './faces.js';
import type { KokoroVoice, RuntimeConfig } from './config.js';
import type { RunningBit } from './bits.js';

export interface PresetFile {
  name: string;
  savedAt?: string;
  persona?: {
    /** The persona template ({{PLACEHOLDERS}} as in src/persona/system-prompt.md). Absent: the built-in one. */
    systemPrompt?: string;
    /** Or a markdown file next to the preset, e.g. "pirate.md". */
    systemPromptFile?: string;
    /** The runtime config's extra instruction ("prompt"). */
    instruction?: string;
  };
  /** Canned lines (src/persona/greetings.json's shape). Absent: the built-in ones. */
  lines?: GreetingsConfig;
  /** Running gags and traits, offered on few turns (contracts/bits.ts). Absent: the built-in ones, tubs.json's. */
  bits?: RunningBit[];
  /** Ming or Kokoro voice names. */
  voices?: { main?: KokoroVoice; small?: KokoroVoice };
  /** glitch* settings, secondaryGlitchFxBaseColor, propMain and propSmall. */
  look?: Partial<RuntimeConfig>;
  /** sleepTimeout, interruptible, dualHeadEnabled, dualHeadMode, dualHeadTurnPolicy. */
  behaviour?: Partial<RuntimeConfig>;
}

export interface PresetSummary {
  name: string;
  savedAt: string | null;
}

/** GET /presets */
export interface PresetsResponse {
  presets: PresetSummary[];
  /** The preset applied or saved last since the server started; null before. */
  active: string | null;
}
