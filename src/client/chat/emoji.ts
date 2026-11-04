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
