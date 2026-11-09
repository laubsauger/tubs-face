// Replies are logged as "<reaction emoji> <text>". Shown inline, the emoji
// makes the reply harder to read, so the chat views lift it into the header.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// A grapheme is an emoji if it shows as one: emoji-style by default, a symbol
// forced to emoji style (U+FE0F), or a flag. Skin tones and ZWJ sequences
// segment as one grapheme. Plain-text symbols such as "©" stay in the text.
const EMOJI_GRAPHEME = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|\p{Regional_Indicator}/u;

export interface SplitEmoji {
  /** The leading emoji run, or '' when the text does not start with one. */
  emoji: string;
  body: string;
}

/** Splits the leading emoji off a chat line. Display only: stored text keeps it. */
export function splitLeadingEmoji(text: string): SplitEmoji {
  const trimmed = text.trimStart();
  let emoji = '';
  for (const { segment } of graphemes.segment(trimmed)) {
    if (!EMOJI_GRAPHEME.test(segment)) break;
    emoji += segment;
  }
  const body = trimmed.slice(emoji.length).trimStart();
  // An emoji-only line has nothing else to show; keep it as the body.
  if (!emoji || !body) {
    return { emoji: '', body: text };
  }
  return { emoji, body };
}

export interface EmojiLine {
  /** The line's reaction emoji, or '' when it has none. */
  emoji: string;
  text: string;
}

/**
 * A reply's lines with each line's leading emoji lifted off. A bit is logged
 * one sentence per line, each with its own reaction; inline, those emojis
 * broke up the text, so the chat log shows them in a narrow column beside it.
 */
export function splitLineEmojis(text: string): EmojiLine[] {
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    const { emoji, body } = splitLeadingEmoji(line);
    return { emoji, text: emoji ? body : line.trim() };
  });
}
