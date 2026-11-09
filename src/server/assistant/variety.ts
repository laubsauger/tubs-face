import { recentModelReplies, wasLastReplyCutOff } from './context.js';
import { hasNotesInView, markNameAsked, nameAskCandidate, peopleInView, pickGossip, type Position } from './field-notes.js';
import { runtimeConfig } from '../config/runtime.js';
import { BIT_MAX_SENTENCES, MAX_OUTPUT_SENTENCES } from './text.js';
import { bitWordStems, bitsToStayOff, lineWords, noteBitLines, offerBit, stem, type Head, type SpokenLine } from './bits.js';

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
// Kept by time as well as by count: on a busy studio night the last ten
// replies are a few minutes, and a motif could come back every quarter of an
// hour without ever being three of the last ten.
interface NotedReply { at: number; lines: SpokenLine[] }
const recentReplies: NotedReply[] = [];
const MOTIF_MEMORY = 10;
const MOTIF_WINDOW_MS = 30 * 60_000;
const MOTIF_KEPT_MAX = 150;
const MOTIF_REPEATS = 3;
const MOTIF_STOPWORDS = new Set(('about after again also always another anyone anything around because been before being better could does doing done dont even every everyone from going have here into just know like look made make maybe more most much never nothing only other over people really right said same says should since some something still than that thats their them then there these they thing things think this those through time very want what when where which while will with would your youre youve '
  + 'the and for you are but not all can was one has his her its our out who why how get got let way too off any did yes now see say two '
  // Numbers ("two-oh-four" is the studio's name) and the swearing the persona asks for are not motifs.
  + 'three four five seven eight nine hundred thousand someone fuck fucking fuckin shit shitty damn').split(' '));

// The body joke (tubs, garbage cans, nylon straps, plastic casing) and the
// studio lore are running bits now (bits.ts): one bit for all their words,
// with a cooldown. The count here is for everything else the heads fall into.

/**
 * What the heads said in a reply that was heard, both heads' lines: the
 * worn-motif memory and the running bits learn from it.
 */
export function noteReplyLines(lines: readonly SpokenLine[], now = Date.now()): void {
  const spoken = lines.filter((line) => line.text.trim()).map((line) => ({ head: line.head, text: line.text }));
  if (spoken.length === 0) return;
  recentReplies.push({ at: now, lines: spoken });
  if (recentReplies.length > MOTIF_KEPT_MAX) recentReplies.shift();
  noteBitLines(spoken, now);
}

/** The last ten, or everything from the last half hour when that is more. */
function motifWindow<T extends { at: number }>(items: readonly T[], now: number): T[] {
  return items.filter((item, index) => index >= items.length - MOTIF_MEMORY || now - item.at <= MOTIF_WINDOW_MS);
}

/** Recent replies, both heads' lines as one text each. */
export function recentReplyTexts(now = Date.now()): string[] {
  return motifWindow(recentReplies, now).map((reply) => reply.lines.map((line) => line.text).join(' '));
}

/** One head's recent lines, by its own count: Small speaks on fewer turns, so its last ten lines reach further back. */
function recentHeadLines(head: Head, now: number): string[] {
  const lines = recentReplies.flatMap((reply) => reply.lines.filter((line) => line.head === head).map((line) => ({ at: reply.at, text: line.text })));
  return motifWindow(lines, now).map((line) => line.text);
}

/**
 * Words and two-word phrases that keep coming back across recent replies,
 * phrases first. Plurals count as the word ("remote", "remotes"), and words a
 * running bit owns are left to the bit.
 */
export function wornMotifs(replies: readonly string[] = recentReplyTexts(), max = 3, owned: ReadonlySet<string> = bitWordStems()): string[] {
  const counts = new Map<string, number>();
  // As first said, for the stage direction; counted by stem.
  const said = new Map<string, string>();
  for (const reply of replies) {
    const words = lineWords(reply);
    const terms = new Set<string>();
    words.forEach((word, index) => {
      if (word.length < 4 || MOTIF_STOPWORDS.has(word)) return;
      const key = stem(word);
      if (owned.has(key)) return;
      terms.add(key);
      if (!said.has(key)) said.set(key, word);
      const next = words[index + 1];
      if (next && next.length >= 3 && !MOTIF_STOPWORDS.has(next) && !owned.has(stem(next))) {
        const phrase = `${key} ${stem(next)}`;
        terms.add(phrase);
        if (!said.has(phrase)) said.set(phrase, `${word} ${next}`);
      }
    });
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const worn = [...counts]
    .filter(([, count]) => count >= MOTIF_REPEATS)
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length);
  const picked: string[] = [];
  for (const [term] of worn) {
    if (picked.some((chosen) => chosen.includes(term) || term.includes(chosen))) continue;
    picked.push(term);
    if (picked.length >= max) break;
  }
  return picked.map((term) => said.get(term) ?? term);
}

/**
 * What the next stage direction tells the heads to stay off: running bits used
 * just now, worn words across both heads, and each head's own. Per head
 * because a tic of Small's ("I can smell your ...") sat among Main's lines in
 * the combined count and was seen in Mini's lines first.
 */
export function stayOffMotifs(now = Date.now()): { all: string[]; main: string[]; small: string[] } {
  const all = [...bitsToStayOff(now), ...wornMotifs(recentReplyTexts(now))];
  const key = (term: string) => lineWords(term).map(stem).join(' ');
  const listed = new Set(all.map(key));
  const own = (head: Head) => wornMotifs(recentHeadLines(head, now), 2).filter((term) => !listed.has(key(term)));
  return { all, main: own('main'), small: own('small') };
}

const HEAD_NAMES: Record<Head, string> = { main: 'Main', small: 'Small' };

function stayOffLines(motifs: { all: string[]; main: string[]; small: string[] }, mode: 'single' | 'dual' | 'proactive'): string[] {
  const quoted = (terms: string[]) => terms.map((term) => `"${term}"`).join(', ');
  const lines: string[] = [];
  if (motifs.all.length > 0) lines.push(`Fresh material: you keep coming back to ${quoted(motifs.all)}. Stay off them this time.`);
  // Tubs alone has only Main's lines, and those are the combined count.
  if (mode !== 'single') {
    for (const head of ['main', 'small'] as const) {
      if (motifs[head].length > 0) lines.push(`${HEAD_NAMES[head]} keeps coming back to ${quoted(motifs[head])}. ${HEAD_NAMES[head]} stays off ${motifs[head].length > 1 ? 'them' : 'it'} this time.`);
    }
  }
  return lines;
}

/** Test helper: no replies noted. */
export function resetMotifMemory(): void {
  recentReplies.length = 0;
  recentSmallEmojis.length = 0;
  lastSmallMove = -1;
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

// Small's face too: told it is calm, it reacted with 🤖 on almost every turn.
const recentSmallEmojis: string[] = [];

export function noteSmallEmoji(emoji: string | null | undefined): void {
  if (!emoji) return;
  recentSmallEmojis.push(emoji);
  if (recentSmallEmojis.length > 3) recentSmallEmojis.shift();
}

function opener(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
}

export interface DualShape {
  text: string;
  /** Small may speak this turn (with a hook; SMALL_HOOK). */
  small: boolean;
}

// Outside a bit each beat is spelled out as one short line: told only the
// beat count, main wrote a five-sentence riff on most turns. And each line
// gets a word limit: "one short sentence" alone came back as 25-30 words (a
// 69-word one once), so a turn ran 16 s or more on one in ten turns.
// Who speaks is decided here too. Small spoke on about two turns in three
// (64% of the two-head turns in the 8-9 Nov transcripts, 18 of 29 on the
// night of 9 Nov), because most shapes asked for two or three speak beats;
// with nothing of its own to say, Small filled the slot with a jab that fit
// any visitor ("Say goodbye instead.", "Give us your teeth."). Now Main
// carries half the turns alone, and Small is invited on about two in five.
const DUAL_SHAPES: ReadonlyArray<DualShape & { until: number }> = [
  { until: 0.5, small: false, text: 'Only Main speaks this time: one sentence, under fifteen words. Small stays quiet or only reacts.' },
  { until: 0.73, small: true, text: 'Main speaks: one sentence, under fifteen words. Small may add one line after it, under twelve words.' },
  { until: 0.8, small: true, text: 'A quick back-and-forth this time, Main, Small, Main, each line under ten words.' },
  { until: 0.88, small: true, text: 'Small answers this one, under twelve words. Main may add one line under ten words, or only react.' },
  { until: 0.97, small: false, text: 'Main takes the room for a bit this time: three to six short sentences in its speak beat, each under twelve words, punchline last. Small stays quiet or only reacts.' },
  { until: 1, small: true, text: 'Small takes the room for a bit this time: three to six short sentences in its speak beat, each under twelve words, punchline last. Main may cut in once with a few words, or stay quiet.' },
];

/**
 * The shape of a two-head turn. One head gets the room for a bit on some
 * turns: two heads trading one-liners every time read as a sketch with no
 * jokes in it.
 */
export function dualShape(roll: number): DualShape {
  const shape = DUAL_SHAPES.find((each) => roll < each.until) ?? DUAL_SHAPES.at(-1)!;
  return { text: shape.text, small: shape.small };
}

// An invitation is not an order. In the logs only a third of Small's lines
// shared a single word with what the visitor or Main had just said; the rest
// were stock threats and insults ("Make the words tiny so they cry.").
export const SMALL_HOOK = "Small speaks only with a hook: one specific word or detail from what they just said, or from Main's line, picked up and turned Small's way. A line that would fit any visitor is not a hook; then Small only reacts and Main answers alone.";

// Given all of its techniques at once, Small took a word literally in five
// of fourteen lines ("Free means it costs zero dollars.", "Plastic means we
// are cheap to replace."): a new tic within twenty turns. One per turn, never
// the same one twice running.
const SMALL_MOVES = [
  'take one word literally and be sincerely puzzled or pleased by what it literally means',
  'follow what was said calmly one step further than anyone wanted, to a quiet, unsettling conclusion',
  'ask the innocent question it raises, the one nobody wants answered',
  'treat one tiny detail of it as the most important thing in the room',
  "take Main's line as a compliment, an instruction or a plain fact",
];
let lastSmallMove = -1;

function pickSmallMove(random: Random): string {
  let index = Math.floor(random() * (lastSmallMove < 0 ? SMALL_MOVES.length : SMALL_MOVES.length - 1));
  if (lastSmallMove >= 0 && index >= lastSmallMove) index += 1;
  lastSmallMove = Math.min(index, SMALL_MOVES.length - 1);
  return SMALL_MOVES[lastSmallMove]!;
}

// "Can you remember that I was wearing a black hoodie tonight?" got "why are
// you begging a lunchbox for validation?", and a real question about how the
// faces run got "go ask Dimi". A jab instead of an answer reads as a bot that
// did not understand, so a real question gets the substance, with the wit on it.
export function isRealQuestion(heard: string): boolean {
  const words = heard.split(/\s+/).filter(Boolean).length;
  return (heard.includes('?') && words >= 4) || words >= 12;
}

const ENGAGE = {
  single: 'They asked or told you something real. Answer what they actually said, for real and in your voice (you know a lot: tech, people, this studio, how you yourself work), and build the joke on that answer, not instead of it.',
  dual: 'They asked or told you something real. Main answers what they actually said, for real and in its voice (you know a lot: tech, people, this studio, how you yourselves work), and builds the joke on that answer, not instead of it.',
} as const;

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
  heard = '',
): string {
  const lines: string[] = [];
  const openers = [...new Set(recent.slice(-4).map(opener).filter(Boolean))];

  // Proactive turns set their own length and want a reaction, so only the
  // opener ban and the stay-off list apply: "say what is on your mind" is
  // where a running bit comes back on its own.
  if (mode === 'proactive') {
    const proactive = [
      ...(openers.length > 0 ? [`Do not start with: ${openers.map((value) => `"${value}"`).join(', ')}.`] : []),
      ...stayOffLines(stayOffMotifs(), mode),
    ];
    return proactive.length > 0 ? `${HEADER}\n${proactive.map((line) => `- ${line}`).join('\n')}` : '';
  }

  let length: LengthKey | null = null;
  let smallOnStage = false;
  let hookAt = -1;
  if (mode === 'single') {
    length = chosenLength ?? pickLength(recent, random);
    // The shape is Tubs's call, not the visitor's: "tell me a long story"
    // getting "I do not have any." is the character.
    lines.push(LENGTHS[length]);
  } else {
    const shape = dualShape(random());
    smallOnStage = shape.small;
    lines.push(shape.text);
    if (shape.small) {
      hookAt = lines.length;
      lines.push(SMALL_HOOK);
    }
  }
  const engage = isRealQuestion(heard);
  if (engage) lines.push(ENGAGE[mode]);

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
  if (mode === 'dual' && recentSmallEmojis.length === 3 && recentSmallEmojis.every((emoji) => emoji === recentSmallEmojis[0])) {
    lines.push(`Small's face has shown ${recentSmallEmojis[0]} three turns in a row. Even if Small only reacts, it feels something else this time.`);
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

  // Tubs has things on his mind; now and then they win over the visitor's
  // topic. Not over a real question: a move like "describe them the way a
  // nature documentary would" there came out as a jab instead of an answer.
  if (engage) {
    // The answer is the move.
  } else if (mode === 'single' && random() < 0.12) {
    // Hooked onto what they said: plain topic skips came out as non-sequiturs.
    lines.push('Bring up what has actually been on your mind, and hook it onto what they just said.');
  } else if (random() < MOVE_CHANCE) {
    lines.push(MOVES[Math.floor(random() * MOVES.length)]!);
  }

  lines.push(...stayOffLines(stayOffMotifs(), mode));

  if (random() < SWEAR_CHANCE) {
    // Main's: Small swearing ("Everything is completely fucked anyway.") was
    // just a second roast; Small's calm is what makes it unsettling.
    lines.push(mode === 'dual'
      ? 'Let Main land a swear word in this one (fuck, shit), where it fits naturally.'
      : 'Let a swear word land in this one (fuck, shit), where it fits naturally.');
  }

  // A running bit on few turns only, off cooldown (bits.ts), to one head.
  // Offered to "either head", both used the remotes in the same turn. The
  // offer is the only way a bit reaches the model; nothing checks or redoes
  // the reply.
  const bit = offerBit(mode, random, Date.now(), heard, smallOnStage);
  if (bit) {
    if (mode === 'single') lines.push(`If it fits what they said, you may use this: ${bit.text}`);
    else if (bit.head === 'small') lines.push(`If it fits what they said, Small may use this as its hook; Main leaves it alone: ${bit.text}`);
    else lines.push(`If it fits what they said, Main may use this; Small leaves it alone: ${bit.text}`);
  }

  // Rolled last, so the rolls above stay where they were.
  if (hookAt >= 0) lines[hookAt] = `${SMALL_HOOK} Small's way this time: ${pickSmallMove(random)}.`;

  return `${HEADER}\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

/**
 * The stage direction for a turn plus how many sentences may be spoken. Both
 * come from one length roll: a bit asked for in the direction must not be cut
 * off after two sentences by the speech cap.
 */
export function directTurn(mode: 'single' | 'dual', heard = ''): { text: string; maxSentences: number } {
  const length = mode === 'single' ? pickLength(recentModelReplies(6), Math.random) : null;
  const text = buildTurnDirection(mode, Math.random, undefined, undefined, undefined, undefined, undefined, length, heard);
  return { text, maxSentences: length === 'bit' || length === 'open' ? BIT_MAX_SENTENCES : MAX_OUTPUT_SENTENCES };
}
