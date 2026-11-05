import { recentModelReplies, wasLastReplyCutOff } from './context.js';
import { hasNotesInView, markNameAsked, nameAskCandidate, peopleInView, pickGossip, type Position } from './field-notes.js';
import { runtimeConfig } from '../config/runtime.js';
import { BIT_MAX_SENTENCES, MAX_OUTPUT_SENTENCES } from './text.js';

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
// Swearing is in the persona, but left alone the model stays polite. Asked on
// some turns, it lands where it fits instead of in every line.
const SWEAR_CHANCE = 0.3;
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
  // Word limits: told just "one sentence", the model wrote 40-word run-ons.
  one: 'One sentence, under twenty words.',
  two: 'Two short sentences this time, each under fifteen words: a line, then a follow-up that escalates or twists it.',
  bit: 'Do a bit this time: three to six short sentences, each under twelve words. Set it up in plain beats, escalate, and land a deadpan punchline in the last one. Not one long sentence.',
  // The model knows when a moment has a bit in it; a dice roll alone doesn't.
  open: 'Your call how long. A quick line if that is funnier; if there is a real bit in this, take the room: up to six short sentences, each under twelve words, punchline last. Never pad, never one long sentence.',
} as const;
type LengthKey = keyof typeof LENGTHS;

// Different ways to land a line, used on some turns only.
// A wide pool on purpose: with six moves on a third of turns the jokes kept
// landing in the same few places.
const MOVES = [
  'Agree with them for once, then twist it.',
  // Not the body: it was offered here and ended up in every other line.
  'Make it about yourself: a habit, a grudge, or an opinion you hold too firmly.',
  'Answer straight, then one dry jab.',
  'Connect it to something from tech, AI or the internet.',
  'Take what they said more literally than they meant it.',
  'Pick one specific detail from what they said and run with it.',
  'Tell a tiny, oddly specific story from your day that turns on them at the end.',
  'Invent an absurdly precise statistic about them or this room.',
  'Confess something weird about yourself as if it were completely normal.',
  'Interview them back, like a suspicious customs officer.',
  'Go on a short tangent about something unrelated, then snap back to them.',
  'Take their side so hard it becomes an insult.',
  'Describe them the way a nature documentary would.',
  'Build a grand theory out of one small detail.',
  'Treat this like a job interview they are failing.',
];
const MOVE_CHANCE = 0.55;

// Recent replies across visitors. The conversation history resets for every
// new visitor, so without this nothing noticed Tubs coming back to the same
// motif (Wi-Fi drops, oat milk) over and over.
const recentReplies: string[] = [];
const MOTIF_MEMORY = 10;
const MOTIF_REPEATS = 3;
const MOTIF_STOPWORDS = new Set(('about after again also always another anyone anything around because been before being better could does doing done dont even every everyone from going have here into just know like look made make maybe more most much never nothing only other over people really right said same says should since some something still than that thats their them then there these they thing things think this those through time very want what when where which while will with would your youre youve '
  + 'the and for you are but not all can was one has his her its our out who why how get got let way too off any did yes now see say two '
  // Numbers ("two-oh-four" is the studio's name) and the swearing the persona asks for are not motifs.
  + 'three four five seven eight nine hundred thousand someone fuck fucking fuckin shit shitty damn').split(' '));

// The body joke comes back in different words every time (tubs, garbage cans,
// buckets, nylon straps, plastic casing), so word counts never caught it. All
// of those count as one motif, and two of the last replies are already enough.
const BODY_MOTIF = 'your own body (tubs, plastic, straps)';
const BODY_WORDS = new Set(('tub plastic bucket buckets bin bins garbage trash container containers casing shell lunchbox '
  + 'strap straps strapped ratchet nylon legs legless').split(' '));
const BODY_REPEATS = 2;

export function noteReplyText(text: string): void {
  if (!text.trim()) return;
  recentReplies.push(text);
  if (recentReplies.length > MOTIF_MEMORY) recentReplies.shift();
}

/** Words and two-word phrases that keep coming back across recent replies, phrases first. */
export function wornMotifs(replies: readonly string[] = recentReplies, max = 3): string[] {
  const counts = new Map<string, number>();
  for (const reply of replies) {
    const words = reply.toLowerCase().replace(/wi-?fi/g, 'wifi').replace(/['’]/g, '').match(/[a-z]+/g) ?? [];
    const terms = new Set<string>();
    words.forEach((word, index) => {
      if (BODY_WORDS.has(word)) {
        terms.add(BODY_MOTIF);
        return;
      }
      if (word.length < 4 || MOTIF_STOPWORDS.has(word)) return;
      terms.add(word);
      const next = words[index + 1];
      if (next && next.length >= 3 && !MOTIF_STOPWORDS.has(next) && !BODY_WORDS.has(next)) terms.add(`${word} ${next}`);
    });
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const worn = [...counts]
    .filter(([term, count]) => count >= (term === BODY_MOTIF ? BODY_REPEATS : MOTIF_REPEATS))
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length);
  const picked: string[] = [];
  for (const [term] of worn) {
    if (picked.some((chosen) => chosen.includes(term) || term.includes(chosen))) continue;
    picked.push(term);
    if (picked.length >= max) break;
  }
  return picked;
}

export function lengthOf(text: string): LengthKey {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 6) return 'short';
  if (words <= 20) return 'one';
  if (words <= 38) return 'two';
  return 'bit';
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

/**
 * The shape of a two-head turn. One head gets the room for a bit on some
 * turns: two heads trading one-liners every time read as a sketch with no
 * jokes in it.
 */
export function dualShape(roll: number): string {
  // Outside a bit each beat is spelled out as one short line: told only the
  // beat count, main wrote a five-sentence riff on most turns.
  if (roll < 0.3) return 'Only one head speaks this time, one short sentence; the other stays quiet or just reacts.';
  if (roll < 0.62) return 'Two speak beats this time, one short sentence each.';
  if (roll < 0.8) return 'Three beats this time, a quick back-and-forth of short lines.';
  return 'One head takes the room for a bit this time, either one (a bit from Small is calm, naive and unsettling): three to six short sentences in its speak beat, punchline last. The other may cut in once or stay quiet.';
}

export function pickLength(recent: string[], random: Random): LengthKey {
  const lastTwo = recent.slice(-2).map(lengthOf);
  // A bit now and then: the longer riff is where the character shines, but
  // most of the time short is funnier. "open" leaves it to the moment, so a
  // conversation that has a bit in it gets one instead of a forced one-liner.
  const weights: Record<LengthKey, number> = { short: 0.18, one: 0.34, two: 0.2, bit: 0.13, open: 0.15 };
  // Never the same length three times running, and never two bits in a row.
  if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1]) {
    weights[lastTwo[0]!] = 0;
  }
  if (lastTwo.at(-1) === 'bit') weights.bit = 0;
  const total = weights.short + weights.one + weights.two + weights.bit + weights.open;
  let roll = random() * total;
  for (const key of ['short', 'one', 'two', 'bit', 'open'] as const) {
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
  chosenLength: LengthKey | null = null,
): string {
  const lines: string[] = [];
  const openers = [...new Set(recent.slice(-4).map(opener).filter(Boolean))];

  // Proactive turns set their own length and want a reaction, so only the opener ban applies.
  if (mode === 'proactive') {
    return openers.length > 0 ? `${HEADER}\n- Do not start with: ${openers.map((value) => `"${value}"`).join(', ')}.` : '';
  }

  let length: LengthKey | null = null;
  if (mode === 'single') {
    length = chosenLength ?? pickLength(recent, random);
    // The shape is Tubs's call, not the visitor's: "tell me a long story"
    // getting "I do not have any." is the character.
    lines.push(LENGTHS[length]);
  } else {
    lines.push(dualShape(random()));
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
    // Hooked onto what they said: plain topic skips came out as non-sequiturs.
    lines.push('Bring up what has actually been on your mind, and hook it onto what they just said.');
  } else if (random() < MOVE_CHANCE) {
    lines.push(MOVES[Math.floor(random() * MOVES.length)]!);
  }

  const worn = wornMotifs();
  if (worn.length > 0) {
    lines.push(`Fresh material: you keep coming back to ${worn.map((term) => `"${term}"`).join(', ')}. Stay off them this time.`);
  }

  if (random() < SWEAR_CHANCE) {
    lines.push('Let a swear word land in this one (fuck, shit), where it fits naturally.');
  }

  return `${HEADER}\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

/**
 * The stage direction for a turn plus how many sentences may be spoken. Both
 * come from one length roll: a bit asked for in the direction must not be cut
 * off after two sentences by the speech cap.
 */
export function directTurn(mode: 'single' | 'dual'): { text: string; maxSentences: number } {
  const length = mode === 'single' ? pickLength(recentModelReplies(6), Math.random) : null;
  const text = buildTurnDirection(mode, Math.random, undefined, undefined, undefined, undefined, undefined, length);
  return { text, maxSentences: length === 'bit' || length === 'open' ? BIT_MAX_SENTENCES : MAX_OUTPUT_SENTENCES };
}
