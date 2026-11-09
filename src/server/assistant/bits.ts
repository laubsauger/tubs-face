// Running bits: the characters' running gags and traits (the projector
// remotes, Dimi's rent, Alan Watts, the body), as data in the character preset
// (contracts/bits.ts), offered on few turns by code.
//
// They used to be lore in the static persona with "now and then when it
// fits". The model sees that on every turn and reaches for whatever is
// salient in it, so the remotes came up in about every second line of Mini's
// and went stale within minutes. Now the persona keeps only neutral facts; a
// bit reaches the model only as an offer in one turn's stage direction, and a
// spoken line that uses it puts it on a wall-clock cooldown.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BitHead, BitStatus, RunningBit } from '../../shared/contracts/bits.js';
import { configDir } from './relationships.js';

export type Head = 'main' | 'small';
export interface SpokenLine { head: Head; text: string }

/** A line's words for matching and counting: lowercase, "Wi-Fi" as one word, no apostrophes. */
export function lineWords(text: string): string[] {
  return text.toLowerCase().replace(/wi-?fi/g, 'wifi').replace(/['’]/g, '').match(/[a-z]+/g) ?? [];
}

/**
 * Singular and plural as one word (remotes, batteries, watches). Only
 * plurals: "remote" and "remotes" were counted as two motifs, so neither
 * reached the repeat limit while the remotes came back every few lines.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

interface Matcher { words: Set<string>; phrases: string[][]; patterns: RegExp[] }

const REGEX_ENTRY = /^\/(.+)\/([a-z]*)$/s;

function compileMatch(entries: readonly string[]): Matcher {
  const matcher: Matcher = { words: new Set(), phrases: [], patterns: [] };
  for (const entry of entries) {
    const regex = REGEX_ENTRY.exec(entry.trim());
    if (regex) {
      // No g or y: a stateful regex would skip every other line.
      const flags = regex[2]!.replace(/[gy]/g, '');
      matcher.patterns.push(new RegExp(regex[1]!, flags.includes('i') ? flags : `${flags}i`));
      continue;
    }
    const words = lineWords(entry).map(stem);
    if (words.length === 0) throw new Error(`"${entry}" has no words to match`);
    if (words.length === 1) matcher.words.add(words[0]!);
    else matcher.phrases.push(words);
  }
  return matcher;
}

function hits(matcher: Matcher, text: string): boolean {
  const stems = lineWords(text).map(stem);
  if (stems.some((word) => matcher.words.has(word))) return true;
  if (matcher.phrases.some((phrase) => stems.some((_, i) => phrase.every((word, j) => stems[i + j] === word)))) return true;
  return matcher.patterns.some((pattern) => pattern.test(text));
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const HEADS: readonly BitHead[] = ['main', 'small', 'both'];

/** A preset's "bits", checked; throws with what is wrong, so a broken preset changes nothing. */
export function parseBits(value: unknown): RunningBit[] {
  if (!Array.isArray(value)) throw new Error('bits must be a list');
  const seen = new Set<string>();
  return value.map((raw: unknown, index) => {
    const where = `bits[${index}]`;
    if (!raw || typeof raw !== 'object') throw new Error(`${where} is not an object`);
    const bit = raw as Partial<RunningBit>;
    if (typeof bit.id !== 'string' || !ID_RE.test(bit.id)) throw new Error(`${where}.id must be 1-40 letters, digits, - or _`);
    if (seen.has(bit.id)) throw new Error(`${where}.id ${bit.id} is used twice`);
    seen.add(bit.id);
    if (typeof bit.text !== 'string' || !bit.text.trim()) throw new Error(`${bit.id}: text is missing`);
    if (!Array.isArray(bit.match) || bit.match.length === 0 || bit.match.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error(`${bit.id}: match must list words or /regex/`);
    }
    try {
      compileMatch(bit.match);
    } catch (error) {
      throw new Error(`${bit.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof bit.cooldownMin !== 'number' || !Number.isFinite(bit.cooldownMin) || bit.cooldownMin <= 0) throw new Error(`${bit.id}: cooldownMin must be minutes above zero`);
    if (bit.chance !== undefined && (typeof bit.chance !== 'number' || !(bit.chance >= 0 && bit.chance <= 1))) throw new Error(`${bit.id}: chance must be 0-1`);
    if (bit.head !== undefined && !HEADS.includes(bit.head)) throw new Error(`${bit.id}: head must be main, small or both`);
    return {
      id: bit.id,
      text: bit.text.trim(),
      match: [...bit.match],
      cooldownMin: bit.cooldownMin,
      ...(bit.chance !== undefined ? { chance: bit.chance } : {}),
      ...(bit.head !== undefined ? { head: bit.head } : {}),
    };
  });
}

// ---- which bits: the applied preset's, else the built-in character's ----

let presetBits: RunningBit[] | null = null;
let builtin: { file: string; mtimeMs: number; bits: RunningBit[] } | null = null;
let builtinProblem = '';

/** The built-in bits live in tubs.json (the built-in character), re-read when it changes. */
function builtInBits(): RunningBit[] {
  const file = path.join(configDir(), 'presets', 'tubs.json');
  try {
    if (!existsSync(file)) return [];
    const { mtimeMs } = statSync(file);
    if (builtin?.file === file && builtin.mtimeMs === mtimeMs) return builtin.bits;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { bits?: unknown };
    builtin = { file, mtimeMs, bits: parsed.bits === undefined ? [] : parseBits(parsed.bits) };
    builtinProblem = '';
    return builtin.bits;
  } catch (error) {
    const problem = `${file}: ${error instanceof Error ? error.message : String(error)}`;
    if (problem !== builtinProblem) console.warn(`[bits] no built-in bits, ${problem}`);
    builtinProblem = problem;
    return [];
  }
}

/** The applied preset's bits, or null for the built-in ones (a preset without "bits"). */
export function setPresetBits(bits: RunningBit[] | null): void {
  presetBits = bits;
}

export function activeBits(): RunningBit[] {
  return presetBits ?? builtInBits();
}

const matchers = new WeakMap<RunningBit, Matcher>();
function matcherOf(bit: RunningBit): Matcher {
  let matcher = matchers.get(bit);
  if (!matcher) {
    matcher = compileMatch(bit.match);
    matchers.set(bit, matcher);
  }
  return matcher;
}

/** Word stems the bits own; the generic worn-motif count leaves them to the bits, so nothing is listed twice. */
export function bitWordStems(): Set<string> {
  const stems = new Set<string>();
  for (const bit of activeBits()) {
    const matcher = matcherOf(bit);
    for (const word of matcher.words) stems.add(word);
    for (const phrase of matcher.phrases) for (const word of phrase) stems.add(word);
  }
  return stems;
}

export const bitLabel = (bit: Pick<RunningBit, 'id'>): string => bit.id.replace(/[-_]+/g, ' ');

// ---- tonight's uses (memory only, like the field notes) ----

interface BitUse { uses: number; lastUsedAt: number | null; lastUsedTurn: number; overused: boolean }
const usage = new Map<string, BitUse>();
const disabled = new Set<string>();
/** Heard replies noted tonight; the stay-off line counts turns, not minutes. */
let turnsNoted = 0;

const minutes = (value: number) => value * 60_000;

function cooldownLeftMs(bit: RunningBit, now: number): number {
  const lastUsedAt = usage.get(bit.id)?.lastUsedAt;
  return lastUsedAt == null ? 0 : Math.max(0, lastUsedAt + minutes(bit.cooldownMin) - now);
}

// Named in the stay-off line only once it was repeated: used again during its
// cooldown, so the model is reaching for it on its own. After a single use
// the cooldown alone keeps it from being offered; naming it then put it in
// front of the model on every turn ("studio wifi" stayed on the list for a
// quarter of an hour after one mention). And only for the next few turns:
// each one that names it puts it in front of the model again.
const STAY_OFF_TURNS = 4;

function staysOff(bit: RunningBit, now: number): boolean {
  const use = usage.get(bit.id);
  if (!use?.overused) return false;
  return turnsNoted - use.lastUsedTurn < STAY_OFF_TURNS && cooldownLeftMs(bit, now) > 0;
}

/**
 * Notes the bits a heard reply used: a match in any head's line counts, once
 * per reply. Returns their ids. A use restarts the cooldown. Answering the
 * visitor about it (their words hit it too) is not a repeat: asked twice
 * about the remotes, Tubs answering twice is a conversation, not a tic.
 */
export function noteBitLines(lines: readonly SpokenLine[], now = Date.now(), heard = ''): string[] {
  turnsNoted += 1;
  const used: string[] = [];
  for (const bit of activeBits()) {
    const matcher = matcherOf(bit);
    if (!lines.some((line) => hits(matcher, line.text))) continue;
    const use = usage.get(bit.id) ?? { uses: 0, lastUsedAt: null, lastUsedTurn: 0, overused: false };
    use.overused = cooldownLeftMs(bit, now) > 0 && !(heard && hits(matcher, heard));
    use.uses += 1;
    use.lastUsedAt = now;
    use.lastUsedTurn = turnsNoted;
    usage.set(bit.id, use);
    used.push(bit.id);
  }
  return used;
}

/** Bits the next stage direction tells the heads to stay off, as labels. */
export function bitsToStayOff(now = Date.now()): string[] {
  return activeBits().filter((bit) => staysOff(bit, now)).map(bitLabel);
}

// Only when the visitor brings it up. Out of the blue, even rarely, an offer
// came out as a non-sequitur every time ("Fair enough, run your little tests
// while the studio plays Alan Watts clips.", "I hid your laptop charger under
// the floorboards." to someone testing the mic); asked about the rent, Dimi
// and the rent came out as an answer.
export const BIT_TOPIC_CHANCE = 0.6;

/**
 * The bit offered this turn, if any: one the visitor's words just hit,
 * enabled, offered at all (chance above 0) and off cooldown. A "small" bit
 * only when Small is invited to speak.
 *
 * Everything acts through the prompt before the one generation call: this
 * offer and the "stay off" line are all there is. No rerun, no regeneration,
 * no post-filter that rejects or rewrites a reply, no extra LLM call. Noticing
 * a bit in a reply (noteBitLines, after it was heard) only updates the state
 * that shapes the next turn's stage direction.
 */
export function offerBit(mode: 'single' | 'dual', random: () => number, now = Date.now(), heard = '', smallOnStage = mode === 'dual'): RunningBit | null {
  if (!heard) return null;
  const onTopic = activeBits().filter((bit) => !disabled.has(bit.id)
    && (bit.chance ?? 1) > 0
    && cooldownLeftMs(bit, now) === 0
    && ((bit.head ?? 'both') !== 'small' || (mode === 'dual' && smallOnStage))
    && hits(matcherOf(bit), heard));
  if (onTopic.length === 0 || random() >= BIT_TOPIC_CHANCE) return null;
  const bit = onTopic[Math.floor(random() * onTopic.length)]!;
  return random() < (bit.chance ?? 1) ? bit : null;
}

/** The operator's on/off for tonight. False when no bit has that id. */
export function setBitEnabled(id: string, enabled: boolean): boolean {
  if (!activeBits().some((bit) => bit.id === id)) return false;
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  return true;
}

export function bitsStatus(now = Date.now()): BitStatus[] {
  return activeBits().map((bit) => {
    const use = usage.get(bit.id);
    return {
      id: bit.id,
      text: bit.text,
      head: bit.head ?? 'both',
      cooldownMin: bit.cooldownMin,
      enabled: !disabled.has(bit.id),
      uses: use?.uses ?? 0,
      lastUsedAt: use?.lastUsedAt ?? null,
      cooldownLeftMs: cooldownLeftMs(bit, now),
      stayOff: staysOff(bit, now),
    };
  });
}

/** Test helper: built-in bits, nothing used, all on. */
export function resetBits(): void {
  presetBits = null;
  builtin = null;
  usage.clear();
  disabled.clear();
  turnsNoted = 0;
}
