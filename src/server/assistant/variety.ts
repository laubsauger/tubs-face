import { recentModelReplies, wasLastReplyCutOff } from './context.js';
import { hasNotesInView, markNameAsked, nameAskCandidate, peopleInView, pickGossip, type Position } from './field-notes.js';
import { runtimeConfig } from '../config/runtime.js';

// Now and then Tubs brings up what an earlier visitor said, so separate
// visitors feel like one audience he is keeping track of.
const GOSSIP_CHANCE = 0.1;
// Notes are always in the prompt; calling one back is decided here so it
// stays a surprise instead of every line.
const NOTE_CALLBACK_CHANCE = 0.2;
// With two or more people, now and then side with one against another.
const ROAST_MIRROR_CHANCE = 0.3;
// Enrolled visitors should hear their name now and then.
const NAME_CHANCE = 0.3;
// Auto onboarding: once an unnamed person has talked a bit, ask their name
// on some turns (once per person), so it comes up naturally.
const ASK_NAME_CHANCE = 0.35;
const SIDE: Record<Position, string> = { left: 'on the left', center: 'in the middle', right: 'on the right' };

interface PersonRef { position: Position; name: string | null }
const refer = (person: PersonRef) => person.name ?? `the one ${SIDE[person.position]}`;

/** Ally and target for the roast mirror: the target is preferably someone Tubs knows things about. */
export function pickRoastMirror(
  people: Array<PersonRef & { noteCount: number }>,
  random: () => number,
): { ally: PersonRef; target: PersonRef } | null {
  if (people.length < 2) return null;
  const known = people.filter((person) => person.noteCount > 0);
  const pool = known.length > 0 && random() < 0.7 ? known : people;
  const target = pool[Math.floor(random() * pool.length)]!;
  const allies = people.filter((person) => person !== target && person.position !== target.position);
  if (allies.length === 0) return null;
  const ally = allies[Math.floor(random() * allies.length)]!;
  return { ally: { position: ally.position, name: ally.name }, target: { position: target.position, name: target.name } };
}

/** A known name among the people in view, if any. */
export function pickName(people: Array<{ name: string | null }>, random: () => number): string | null {
  const named = people.map((person) => person.name).filter((name): name is string => Boolean(name));
  return named.length > 0 ? named[Math.floor(random() * named.length)]! : null;
}

const HEADER = '[Stage direction for this reply, not said by the visitor]';

/**
 * Per-turn direction sent with the newest user message, decided in code so replies
 * vary the way people do: different lengths, not always ending on a question,
 * no recycled openers, sometimes a different comedic move. A model left to
 * itself settles into one shape (one 15-word roast + question) and visitors
 * notice within a few turns.
 */

type Random = () => number;

const LENGTHS = {
  short: 'Six words or fewer. One quick jab, nothing else.',
  one: 'One sentence.',
  two: 'Two short sentences this time: a line, then a follow-up that escalates or twists it.',
} as const;
type LengthKey = keyof typeof LENGTHS;

// Different ways to land a line, used on some turns only.
const MOVES = [
  'Agree with them for once, then twist it.',
  'Make it about yourself and your plastic-tub body.',
  'Answer straight, then one dry jab.',
  'Connect it to something from tech, AI or the internet.',
  'Take what they said more literally than they meant it.',
  'Pick one specific detail from what they said and run with it.',
];

export function lengthOf(text: string): LengthKey {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 6) return 'short';
  if (words <= 20) return 'one';
  return 'two';
}

// Emotion emojis of the last replies; the face shows them, so a run of the
// same one reads as a stuck face.
const recentEmojis: string[] = [];

export function noteReplyEmoji(emoji: string | null | undefined): void {
  if (!emoji) return;
  recentEmojis.push(emoji);
  if (recentEmojis.length > 4) recentEmojis.shift();
}

function opener(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
}

function pickLength(recent: string[], random: Random): LengthKey {
  const lastTwo = recent.slice(-2).map(lengthOf);
  const weights: Record<LengthKey, number> = { short: 0.25, one: 0.5, two: 0.25 };
  // Never the same length three times running.
  if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1]) {
    weights[lastTwo[0]!] = 0;
  }
  const total = weights.short + weights.one + weights.two;
  let roll = random() * total;
  for (const key of ['short', 'one', 'two'] as const) {
    roll -= weights[key];
    if (roll < 0) return key;
  }
  return 'one';
}

export function buildTurnDirection(
  mode: 'single' | 'dual' | 'proactive',
  random: Random = Math.random,
  recent: string[] = recentModelReplies(6),
  emojis: readonly string[] = recentEmojis,
  cutOff: boolean = wasLastReplyCutOff(),
  gossip: { text: string; name: string | null } | null = Math.random() < GOSSIP_CHANCE ? pickGossip() : null,
  group: {
    mirror: { ally: PersonRef; target: PersonRef } | null;
    callBackNote: boolean;
    useName: string | null;
    askName?: { position: Position; inGroup: boolean } | null;
  } = {
    mirror: Math.random() < ROAST_MIRROR_CHANCE ? pickRoastMirror(peopleInView(), Math.random) : null,
    callBackNote: hasNotesInView() && Math.random() < NOTE_CALLBACK_CHANCE,
    useName: Math.random() < NAME_CHANCE ? pickName(peopleInView(), Math.random) : null,
    askName: runtimeConfig.autoEnrollEnabled && Math.random() < ASK_NAME_CHANCE ? nameAskCandidate() : null,
  },
): string {
  const lines: string[] = [];
  const openers = [...new Set(recent.slice(-4).map(opener).filter(Boolean))];

  // Proactive turns set their own length and want a reaction, so only the opener ban applies.
  if (mode === 'proactive') {
    return openers.length > 0 ? `${HEADER}\n- Do not start with: ${openers.map((value) => `"${value}"`).join(', ')}.` : '';
  }

  let length: LengthKey | null = null;
  if (mode === 'single') {
    length = pickLength(recent, random);
    // The shape is Tubs's call, not the visitor's: "tell me a long story"
    // getting "I do not have any." is the character.
    lines.push(LENGTHS[length]);
  } else {
    const roll = random();
    lines.push(roll < 0.35
      ? 'Only one head speaks this time; the other stays quiet or just reacts.'
      : roll < 0.8 ? 'Two speak beats this time.' : 'Three beats this time, a quick back-and-forth.');
  }

  const lastThree = recent.slice(-3);
  const questions = lastThree.filter((text) => text.trim().endsWith('?')).length;
  if (questions >= 2) {
    lines.push('Do not end with a question.');
  } else if (length !== 'short' && recent.length >= 3 && recent.slice(-4).every((text) => !text.trim().endsWith('?')) && random() < 0.35) {
    // Not on a six-word jab: the question doubled its length every time.
    lines.push('End with one specific, unexpected question.');
  }

  if (openers.length > 0) {
    lines.push(`Do not start with: ${openers.map((value) => `"${value}"`).join(', ')}.`);
  }

  // People notice when they talk over someone; so should Tubs, but only now and
  // then, or every interruption gets the same "Rude." back.
  if (cutOff && random() < 0.4) {
    lines.push('They talked over your last reply. You may call that out in a few words, then answer them.');
  }

  const lastEmojis = emojis.slice(-3);
  if (lastEmojis.length === 3 && lastEmojis.every((emoji) => emoji === lastEmojis[0])) {
    lines.push(`Your face has shown ${lastEmojis[0]} three replies in a row. Feel something else this time and pick a different emoji.`);
  }

  if (group.askName) {
    const { position, inGroup } = group.askName;
    lines.push(inGroup
      ? `Ask the one ${SIDE[position]} their name, your way, pointing at them by what they wear. You collect names.`
      : 'Ask them their name, your way. You collect names.');
    markNameAsked(position);
  } else if (group.mirror) {
    const { ally, target } = group.mirror;
    lines.push(`There are several people here. Side with ${refer(ally)} and roast ${refer(target)} to them, using what you see or know about them. Call people by name where you know it, otherwise by what they wear or do, never by left or right.`);
  } else if (group.callBackNote) {
    lines.push('Call back one thing from your notes on them, in passing.');
  }
  if (group.useName && !group.mirror) {
    lines.push(`Use ${group.useName}'s name this time.`);
  }

  if (mode !== 'dual' && gossip) {
    lines.push(gossip.name
      ? `Earlier tonight ${gossip.name} said: "${gossip.text}". Bring it up if it fits, by name.`
      : `Earlier tonight another visitor said: "${gossip.text}". Bring it up if it fits, without saying who.`);
  }

  // Tubs has things on his mind; now and then they win over the visitor's topic.
  if (mode === 'single' && random() < 0.12) {
    lines.push('Skip their topic and say what has actually been on your mind.');
  } else if (random() < 0.3) {
    lines.push(MOVES[Math.floor(random() * MOVES.length)]!);
  }

  return `${HEADER}\n${lines.map((line) => `- ${line}`).join('\n')}`;
}
