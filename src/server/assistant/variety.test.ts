import { describe, expect, it } from 'vitest';
import { buildTurnDirection, lengthOf } from './variety.js';

// Variety is decided in code so the model can't settle into one reply shape.
const fixed = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('buildTurnDirection', () => {
  it('never asks for the same length three times running', () => {
    const shortReplies = ['Nice hat.', 'Bold move.'];
    for (const roll of [0, 0.1, 0.2, 0.5, 0.9, 0.99]) {
      expect(buildTurnDirection('single', fixed(roll, 0.99, 0.99), shortReplies)).not.toContain('Six words or fewer');
    }
  });

  it('draws different lengths across turns', () => {
    const seen = new Set<string>();
    for (const roll of [0.05, 0.5, 0.95]) {
      seen.add(buildTurnDirection('single', fixed(roll, 0.99, 0.99), []).split('\n')[1]!);
    }
    expect(seen.size).toBe(3);
  });

  it('stops questions after two of the last three replies ended on one', () => {
    const recent = ['What is that?', 'Fine.', 'Why would you?'];
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), recent)).toContain('Do not end with a question.');
  });

  it('bans the openers Tubs used recently', () => {
    const recent = ['So you think robots dream?', 'So you are the reason.'];
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), recent)).toContain('Do not start with: "so you"');
  });

  it('varies the number of beats in two-head mode', () => {
    expect(buildTurnDirection('dual', fixed(0.1, 0.99, 0.99), [])).toContain('Only one head speaks');
    expect(buildTurnDirection('dual', fixed(0.9, 0.99, 0.99), [])).toContain('Three beats');
  });

  it('proactive lines keep their own length and only avoid recent openers', () => {
    const direction = buildTurnDirection('proactive', fixed(0.5), ['So you came back.', 'What is that?', 'Why though?']);
    expect(direction).toBe('[Stage direction for this reply, not said by the visitor]\n- Do not start with: "so you", "what is", "why though".');
    expect(buildTurnDirection('proactive', fixed(0.5), [])).toBe('');
  });

  // The emoji sets the face; the model left alone picks smug nearly every time.
  it('asks for a different feeling after three replies with the same emoji', () => {
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], ['😏', '😏', '😏'])).toContain('shown 😏 three replies in a row');
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], ['😏', '😤', '😏'])).not.toContain('in a row');
  });

  it('sometimes lets Tubs react to being talked over, never every time', () => {
    const reactions = [0.1, 0.39, 0.41, 0.9].map((roll) => buildTurnDirection('single', fixed(0.5, roll, 0.99), [], [], true).includes('talked over'));
    expect(reactions).toEqual([true, true, false, false]);
    expect(buildTurnDirection('single', fixed(0.5, 0.1, 0.99), [], [], false)).not.toContain('talked over');
  });

  it('classifies reply length by words', () => {
    expect(lengthOf('Nice hat.')).toBe('short');
    expect(lengthOf('That jacket screams I want to look outdoorsy but I fear grass.')).toBe('one');
  });
});
