// Running bits (server/assistant/bits.ts): the characters' running gags and
// traits, as data in the character preset (config/presets/<name>.json "bits").
// Code decides when one is offered; the model only writes the line.

export type BitHead = 'main' | 'small' | 'both';

export interface RunningBit {
  /** Stable name; the dashboard and the "stay off" line show it with spaces for dashes. */
  id: string;
  /** What the stage direction offers on the turns it is rolled: the premise, not a line to say. */
  text: string;
  /**
   * When a spoken line counts as using the bit, in any head's line: a word
   * (plurals count: "remote" also hits "remotes"), a few words in a row
   * ("alan watts"), or a "/regex/" tested on the line, case-insensitive.
   */
  match: string[];
  /** Minutes after a use before it is offered again. */
  cooldownMin: number;
  /** 0-1, default 1: once rolled for a turn, how likely it is really offered (0.5: half as often as the others). 0: never offered, only watched, so a repeat is caught. */
  chance?: number;
  /** Who may be offered it in a two-head turn; default both. A "small" bit is never offered to Tubs alone. */
  head?: BitHead;
}

export interface BitStatus {
  id: string;
  text: string;
  head: BitHead;
  cooldownMin: number;
  enabled: boolean;
  /** Times a spoken line used it since the server started. */
  uses: number;
  lastUsedAt: number | null;
  /** 0 when it may be offered. */
  cooldownLeftMs: number;
  /** The next stage direction tells the heads to stay off it. */
  stayOff: boolean;
}

/** GET /bits, POST /bits {id, enabled} */
export interface BitsResponse {
  /** The server's clock, for "how long ago" on a dashboard whose clock may differ. */
  now: number;
  bits: BitStatus[];
  /** What the next turn's stage direction tells the heads to stay off: running bits and worn words, per head. */
  stayOff: { all: string[]; main: string[]; small: string[] };
}
