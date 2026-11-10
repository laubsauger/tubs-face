import { describe, expect, it } from 'vitest';
import { splitLeadingEmoji, splitLineEmojis } from './emoji.js';

// Replies are logged as "<reaction emoji> <text>". In the chat views the emoji
// sits in the entry header so the reply itself reads as plain text.
describe('splitLeadingEmoji', () => {
  it('lifts a single leading emoji out of the reply', () => {
    expect(splitLeadingEmoji('😤 Oh, you again.')).toEqual({ emoji: '😤', body: 'Oh, you again.' });
  });

  it('keeps a variation-selector emoji whole', () => {
    expect(splitLeadingEmoji('☺️ Fine, I suppose.')).toEqual({ emoji: '☺️', body: 'Fine, I suppose.' });
    expect(splitLeadingEmoji('❤️ Love the hat.')).toEqual({ emoji: '❤️', body: 'Love the hat.' });
  });

  it('keeps ZWJ sequences, skin tones and flags whole', () => {
    expect(splitLeadingEmoji('🤷‍♂️ Whatever.')).toEqual({ emoji: '🤷‍♂️', body: 'Whatever.' });
    expect(splitLeadingEmoji('👋🏽 Hi there.')).toEqual({ emoji: '👋🏽', body: 'Hi there.' });
    expect(splitLeadingEmoji('🇩🇪 Guten Abend.')).toEqual({ emoji: '🇩🇪', body: 'Guten Abend.' });
  });

  it('leaves text without an emoji untouched', () => {
    expect(splitLeadingEmoji('Nice hat.')).toEqual({ emoji: '', body: 'Nice hat.' });
  });

  it('leaves an emoji that is not at the start in the reply', () => {
    expect(splitLeadingEmoji('Oh no 😤 not you.')).toEqual({ emoji: '', body: 'Oh no 😤 not you.' });
  });

  it('does not take plain-text symbols or digits for an emoji', () => {
    expect(splitLeadingEmoji('© Tubs, all rights reserved.')).toEqual({ emoji: '', body: '© Tubs, all rights reserved.' });
    expect(splitLeadingEmoji('3 people, wow.')).toEqual({ emoji: '', body: '3 people, wow.' });
  });

  it('keeps an emoji-only line as the body, so the card is not empty', () => {
    expect(splitLeadingEmoji('🙄')).toEqual({ emoji: '', body: '🙄' });
  });
});

describe('splitLineEmojis', () => {
  // A bit arrives one sentence per line, each with its own reaction: the text
  // must read clean while every line keeps its expression beside it.
  it('lifts each line\'s reaction emoji off its text', () => {
    expect(splitLineEmojis('Flo, I watched a spider.\n🙂 It worked so hard.\n😏 Like your management style.')).toEqual([
      { emoji: '', text: 'Flo, I watched a spider.' },
      { emoji: '🙂', text: 'It worked so hard.' },
      { emoji: '😏', text: 'Like your management style.' },
    ]);
  });

  it('keeps emojis inside a sentence and drops empty lines', () => {
    expect(splitLineEmojis('I like 🕷 spiders.\n\n')).toEqual([{ emoji: '', text: 'I like 🕷 spiders.' }]);
  });
});
