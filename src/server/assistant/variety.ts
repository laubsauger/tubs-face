import { recentModelReplies, wasLastReplyCutOff } from './context.js';

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
    // The dice set the shape; an explicit ask from the visitor still wins.
    lines.push(`${LENGTHS[length]} If they explicitly asked for something long or short, give them that instead.`);
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

  if (random() < 0.3) {
    lines.push(MOVES[Math.floor(random() * MOVES.length)]!);
  }

  return `${HEADER}\n${lines.map((line) => `- ${line}`).join('\n')}`;
}
