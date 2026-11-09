import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from '../llm/types.js';
import type { SpokenLine } from './bits.js';

// Running gags used to be lore in the static persona ("now and then when it
// fits"), and the model reached for them on every turn: the projector remotes
// came up in about every second line of Mini's. Now code offers a bit on few
// turns, a use puts it on a wall-clock cooldown, and a bit used just now (or
// again during its cooldown) is named in the "stay off" line. The model only
// writes the line: one generation call per turn, nothing redone or filtered.

const fakes = vi.hoisted(() => ({ provider: null as unknown as LlmProvider }));
vi.mock('../llm/provider.js', () => ({ resolveLlmProvider: () => fakes.provider }));
vi.mock('../observability/conversation-log.js', () => ({ logConversation: async () => {}, logTubsReply: async () => {} }));
vi.mock('../observability/langfuse.js', () => ({ captureTurnTrace: () => {} }));

const { activeBits, bitsStatus, offerBit, resetBits, setBitEnabled, setPresetBits } = await import('./bits.js');
const { buildTurnDirection, noteReplyLines, recentReplyTexts, resetMotifMemory, stayOffMotifs, wornMotifs } = await import('./variety.js');
const { buildAssistantSystemInstruction, buildDualHeadSystemInstruction } = await import('./prompt.js');
const { runtimeConfig } = await import('../config/runtime.js');
const { startUserTurn } = await import('./turns.js');
const { forgetConversation } = await import('./context.js');

/** Seeded, so "most turns" is a fixed sample, not a flaky one. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 9, 21, 0, 0);
const NO_GROUP = { mirror: null, callBackNote: false, useName: null, askName: null };
const direction = (mode: 'single' | 'dual', random: () => number, heard = '') => buildTurnDirection(mode, random, ['Nice hat.'], [], false, null, NO_GROUP, null, heard);
const status = (id: string, now: number) => bitsStatus(now).find((bit) => bit.id === id)!;
const remotes = () => activeBits().find((bit) => bit.id === 'projector-remotes')!;

/** Which bit ids get offered over many turns at this time. */
function offeredOver(turns: number, mode: 'single' | 'dual', now: number, heard = '', smallOnStage = mode === 'dual', seed = 7): Map<string, number> {
  const random = seeded(seed);
  const seen = new Map<string, number>();
  for (let i = 0; i < turns; i += 1) {
    const bit = offerBit(mode, random, now, heard, smallOnStage);
    if (bit) seen.set(bit.id, (seen.get(bit.id) ?? 0) + 1);
  }
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
  resetBits();
  resetMotifMemory();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('running bits', () => {
  // The bug the user saw, in Small's line. Both heads' lines count.
  it('after Small says the remotes vanished again, they are not offered for their cooldown and the direction says to stay off them', () => {
    noteReplyLines([{ head: 'main', text: 'Nice coat.' }, { head: 'small', text: 'The remotes vanished again.' }], T0);

    expect(status('projector-remotes', T0)).toMatchObject({ uses: 1, lastUsedAt: T0, cooldownLeftMs: remotes().cooldownMin * MIN });
    for (const after of [1, 20, remotes().cooldownMin - 1]) {
      expect(offeredOver(2000, 'dual', T0 + after * MIN).has('projector-remotes')).toBe(false);
    }
    expect(offeredOver(2000, 'dual', T0 + (remotes().cooldownMin + 1) * MIN, 'Where did the remote go?').has('projector-remotes')).toBe(true);

    const next = direction('dual', () => 0.99);
    expect(next).toMatch(/Stay off them this time/);
    expect(next).toContain('"projector remotes"');
  });

  it('keeps the remotes, the one the user tired of, on a longer cooldown than the other bits', () => {
    const others = activeBits().filter((bit) => bit.id !== 'projector-remotes');
    expect(others.length).toBeGreaterThan(0);
    expect(remotes().cooldownMin).toBeGreaterThan(Math.max(...others.map((bit) => bit.cooldownMin)));
  });

  // Counted apart, none of the three reached a repeat limit while together
  // they were the same joke every few lines.
  it('counts "remote", "remotes" and "projector remote" as one bit and lists it once', () => {
    noteReplyLines([{ head: 'main', text: 'Did you take the remote?' }], T0);
    noteReplyLines([{ head: 'small', text: 'Remotes taste like fear.' }], T0 + MIN);
    noteReplyLines([{ head: 'main', text: 'Blame the projector remote.' }], T0 + 2 * MIN);

    expect(status('projector-remotes', T0 + 2 * MIN).uses).toBe(3);
    const stayOff = stayOffMotifs(T0 + 2 * MIN);
    expect(stayOff.all.filter((term) => /remote|projector/.test(term))).toEqual(['projector remotes']);
    expect([...stayOff.main, ...stayOff.small].filter((term) => /remote|projector/.test(term))).toEqual([]);
    expect(wornMotifs(recentReplyTexts(T0 + 2 * MIN)).filter((term) => /remote|projector/.test(term))).toEqual([]);
  });

  // At 15% of turns, offered whatever the visitor was on about, bits came out
  // as non-sequiturs ("I hid your laptop charger under the floorboards." to
  // someone testing the mic). Rare out of the blue; likely on topic.
  it('offers a bit rarely out of the blue, and likely when the visitor brings its topic up', () => {
    const rate = (heard: string) => {
      const random = seeded(42);
      let offered = 0;
      for (let i = 0; i < 2000; i += 1) if (direction('dual', random, heard).includes('may use this')) offered += 1;
      return offered / 2000;
    };
    expect(rate('')).toBeGreaterThan(0.005);
    expect(rate('')).toBeLessThan(0.08);
    expect(rate('I am trying to test the subtitles on the small displays.')).toBeLessThan(0.08);
    const remotesOffered = offeredOver(2000, 'dual', T0, 'And where are all the projector remotes going?').get('projector-remotes') ?? 0;
    expect(remotesOffered / 2000).toBeGreaterThan(0.2);
  });

  // Offered to "either head", both heads used the remotes in the same turn.
  it('offers a bit to one head only', () => {
    const offers = Array.from({ length: 300 }, (_, i) => direction('dual', seeded(i), 'Where are the projector remotes?')).flatMap((text) => text.split('\n').filter((line) => line.includes('may use this')));
    expect(offers.length).toBeGreaterThan(0);
    for (const line of offers) {
      expect(line).not.toMatch(/either head/);
      expect(line).toMatch(/Main may use this; Small leaves it alone|Small may use this as its hook; Main leaves it alone/);
    }
  });

  it('never offers a bit the operator switched off, and still offers the others', () => {
    expect(setBitEnabled('projector-remotes', false)).toBe(true);
    const seen = offeredOver(3000, 'dual', T0);
    expect(seen.has('projector-remotes')).toBe(false);
    expect(seen.size).toBeGreaterThan(0);
    expect(status('projector-remotes', T0).enabled).toBe(false);
    expect(setBitEnabled('no-such-bit', false)).toBe(false);
  });

  // A Small bit out of the blue is exactly the disconnected side stab the
  // user tired of; it needs the visitor to have brought it up, and Small on stage.
  it('offers a bit of Small\'s only when the visitor brought it up and Small is invited to speak', () => {
    setPresetBits([
      { id: 'small-eats-batteries', text: 'Small eats batteries.', match: ['battery'], cooldownMin: 20, head: 'small' },
      { id: 'tubs-hates-mondays', text: 'Tubs hates Mondays.', match: ['monday'], cooldownMin: 20 },
    ]);
    const heard = 'Do you run on batteries?';
    expect(offeredOver(3000, 'single', T0, heard).has('small-eats-batteries')).toBe(false);
    expect(offeredOver(3000, 'dual', T0, '', true).has('small-eats-batteries')).toBe(false);
    expect(offeredOver(3000, 'dual', T0, heard, false).has('small-eats-batteries')).toBe(false);
    expect(offeredOver(3000, 'dual', T0, heard, true).has('small-eats-batteries')).toBe(true);
    const offers = Array.from({ length: 400 }, (_, i) => direction('dual', seeded(i), heard)).filter((text) => text.includes('Small eats batteries.'));
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((text) => text.includes('Small may use this as its hook; Main leaves it alone: Small eats batteries.'))).toBe(true);
  });

  // The tub joke never repeats a word (garbage cans, buckets, nylon straps,
  // plastic casing), but it is one joke. "Tubs" is also his name, and saying
  // it is not the joke.
  it('counts the body joke in any words as one bit, and not his name', () => {
    noteReplyLines([{ head: 'main', text: 'I am Tubs, and that is Mini Tubs.' }], T0);
    expect(status('your-own-body', T0).uses).toBe(0);
    noteReplyLines([{ head: 'main', text: 'Look at me, two garbage cans strapped together.' }], T0 + MIN);
    noteReplyLines([{ head: 'small', text: 'My plastic casing is jealous.' }], T0 + 2 * MIN);
    noteReplyLines([{ head: 'main', text: 'Just two tubs and a dream.' }], T0 + 3 * MIN);
    expect(status('your-own-body', T0 + 3 * MIN).uses).toBe(3);
    expect(stayOffMotifs(T0 + 3 * MIN).all).toContain('your own body');
  });

  // A "stay off" list naming every bit on cooldown would put all the lore back
  // in front of the model every turn. Only one used just now, or one the model
  // reached for again during its cooldown.
  it('names a bit to stay off right after a use, and for its whole cooldown once it is used again during it', () => {
    noteReplyLines([{ head: 'main', text: 'Dimi pays the rent, I pay attention.' }], T0);
    expect(status('dimi-and-the-rent', T0 + 5 * MIN).stayOff).toBe(true);
    expect(status('dimi-and-the-rent', T0 + 15 * MIN)).toMatchObject({ stayOff: false });
    expect(status('dimi-and-the-rent', T0 + 15 * MIN).cooldownLeftMs).toBeGreaterThan(0);

    noteReplyLines([{ head: 'small', text: 'The landlord is listening.' }], T0 + 20 * MIN);
    const cooldown = activeBits().find((bit) => bit.id === 'dimi-and-the-rent')!.cooldownMin;
    expect(status('dimi-and-the-rent', T0 + (20 + cooldown - 1) * MIN).stayOff).toBe(true);
    expect(status('dimi-and-the-rent', T0 + (20 + cooldown + 1) * MIN).stayOff).toBe(false);
  });

  it('refuses a broken bit instead of guessing', async () => {
    const { parseBits } = await import('./bits.js');
    expect(() => parseBits([{ id: 'x', text: 'X.', match: ['/(/'], cooldownMin: 5 }])).toThrow(/x:/);
    expect(() => parseBits([{ id: 'x', text: 'X.', match: [], cooldownMin: 5 }])).toThrow(/match/);
    expect(() => parseBits([{ id: 'x', text: 'X.', match: ['x'], cooldownMin: 0 }])).toThrow(/cooldownMin/);
    expect(() => parseBits([{ id: 'x', text: 'X.', match: ['x'], cooldownMin: 5 }, { id: 'x', text: 'Y.', match: ['y'], cooldownMin: 5 }])).toThrow(/twice/);
  });
});

describe('worn motifs beyond the running bits', () => {
  // On a busy night ten replies are a few minutes; a motif from a quarter of
  // an hour ago was out of the window and came straight back.
  it('remembers the last half hour on a busy night, not only the last ten replies', () => {
    for (let i = 0; i < 15; i += 1) {
      noteReplyLines([{ head: 'main', text: i < 3 ? 'The printer is judging you.' : 'Yes.' }], T0 + i * MIN);
    }
    expect(wornMotifs(recentReplyTexts(T0 + 15 * MIN))).toContain('printer');
    expect(wornMotifs(recentReplyTexts(T0 + 3 * 60 * MIN))).not.toContain('printer');
  });

  // Small speaks on fewer turns. Its tic ("I can smell your ...") was spread
  // past the last ten replies and never reached the combined limit.
  it('tracks Small\'s own lines, and tells Small by name', () => {
    const smells = ['I can smell your fear.', 'I can smell your lunch.', 'I can smell your lies.'];
    for (let turn = 0; turn < 12; turn += 1) {
      const lines: SpokenLine[] = [{ head: 'main', text: 'Yes.' }];
      if (turn % 4 === 0) lines.push({ head: 'small', text: smells[turn / 4]! });
      noteReplyLines(lines, T0 + turn * 10 * MIN);
    }
    const now = T0 + 115 * MIN;
    expect(wornMotifs(recentReplyTexts(now))).not.toContain('smell');
    expect(stayOffMotifs(now).small).toContain('smell');
    vi.setSystemTime(now);
    expect(direction('dual', () => 0.99)).toContain('Small keeps coming back to "smell". Small stays off it this time.');
    expect(direction('single', () => 0.99)).not.toContain('Small keeps');
  });
});

describe('the static persona', () => {
  // Salient lore in the prompt the model sees every turn is what made it a tic.
  it.each([
    ['single', buildAssistantSystemInstruction],
    ['dual-head', buildDualHeadSystemInstruction],
  ])('%s mode no longer carries the running bits, only the neutral facts', (_mode, build) => {
    const prompt = build();
    for (const lore of [/remote/i, /alan watts/i, /landlord/i, /\brent\b/i, /wi-?fi/i, /cheapest joke/i, /now and then when it fits/i]) {
      expect(prompt).not.toMatch(lore);
    }
    for (const fact of ['two-oh-four', 'Dimi', 'Flo', 'Rafa']) expect(prompt).toContain(fact);
  });

  it('kept the lore as bits in the built-in character', () => {
    expect(activeBits().map((bit) => bit.id)).toEqual(expect.arrayContaining(['projector-remotes', 'dimi-and-the-rent', 'alan-watts', 'studio-wifi', 'your-own-body']));
  });
});

// The user's constraint: everything acts through the prompt before the one
// generation call. A reply that uses a bit on cooldown is played as it is;
// noticing it only shapes the next turn's stage direction.
describe('a turn that uses a bit on cooldown', () => {
  const snapshot = structuredClone(runtimeConfig);
  afterEach(() => {
    Object.assign(runtimeConfig, structuredClone(snapshot));
    forgetConversation();
  });

  it('still makes exactly one generation call, plays the reply unchanged, and only the next direction says to stay off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    runtimeConfig.dualHeadEnabled = true;
    runtimeConfig.dualHeadMode = 'llm_directed';
    runtimeConfig.dualHeadTurnPolicy = 'llm_order';
    runtimeConfig.ttsStreamingEnabled = false;
    runtimeConfig.muted = false;
    // Used half an hour ago: on its hour-long cooldown, no longer on the stay-off list.
    noteReplyLines([{ head: 'main', text: 'Somebody stole the projector remote.' }], T0 - 30 * MIN);
    expect(status('projector-remotes', T0)).toMatchObject({ stayOff: false });
    expect(status('projector-remotes', T0).cooldownLeftMs).toBeGreaterThan(0);

    const generateContent = vi.fn(async () => ({
      text: JSON.stringify({ beats: [
        { actor: 'main', action: 'speak', text: 'Nice coat.', emoji: '😏' },
        { actor: 'small', action: 'speak', text: 'The remotes vanished again.' },
      ] }),
      usage: { promptTokenCount: 10, candidatesTokenCount: 5 },
      model: 'fake-model',
    }));
    fakes.provider = { id: 'gemini', getAuthState: () => ({ ready: true, warningMessage: null, auth: null }), generateContent };

    const result = await startUserTurn({ text: 'where is everything', source: 'text', broadcast: () => {} });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result?.beats?.find((beat) => beat.actor === 'small')?.text).toBe('The remotes vanished again.');
    expect(status('projector-remotes', T0)).toMatchObject({ uses: 2, stayOff: true });
    expect(direction('dual', () => 0.99)).toContain('"projector remotes"');
  });
});
