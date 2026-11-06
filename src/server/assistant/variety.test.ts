import { describe, expect, it, vi } from 'vitest';
import { BIT_MAX_SENTENCES } from './text.js';
import { buildTurnDirection, directTurn, dualShape, lengthOf, pickLength, pickName, pickRoastMirror, wornMotifs } from './variety.js';

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

  it('never pairs a six-word jab with an invited question', () => {
    const noQuestions = ['Fine.', 'That jacket screams I want to look outdoorsy but I fear grass.', 'Wow, okay then.'];
    expect(buildTurnDirection('single', fixed(0.05, 0, 0.99), noQuestions)).not.toContain('unexpected question');
    expect(buildTurnDirection('single', fixed(0.5, 0, 0.99), noQuestions)).toContain('unexpected question');
  });

  it('bans the openers Tubs used recently', () => {
    const recent = ['So you think robots dream?', 'So you are the reason.'];
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), recent)).toContain('Do not start with: "so you"');
  });

  it('varies the number of beats in two-head mode', () => {
    expect(buildTurnDirection('dual', fixed(0.1, 0.99, 0.99), [])).toContain('Only one head speaks');
    expect(buildTurnDirection('dual', fixed(0.7, 0.99, 0.99), [])).toContain('Three beats');
  });

  // Two heads trading one-liners every turn never got to a joke: on some
  // turns one head gets the room for a whole bit. Not too many: on one in
  // five turns the replies felt long and slow (the user, Nov 6, 2026).
  it('gives one head room for a bit on some two-head turns, about one in eight', () => {
    const shapes = Array.from({ length: 100 }, (_, i) => dualShape(i / 100));
    const bits = shapes.filter((shape) => shape.includes('takes the room for a bit')).length;
    expect(bits).toBeGreaterThanOrEqual(8);
    expect(bits).toBeLessThanOrEqual(16);
  });

  // "One short sentence" alone came back as 25-30 words. Every two-head shape
  // says how short its lines are.
  it('caps the words of every line in every two-head shape', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(dualShape(i / 100)).toMatch(/under (ten|twelve|fifteen) words/);
    }
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

  // Tubs is not a service: some turns his own thoughts beat the visitor's topic.
  it('now and then lets Tubs ignore the topic for what is on his mind', () => {
    expect(buildTurnDirection('single', fixed(0.5, 0.05), [])).toContain('what has actually been on your mind');
    expect(buildTurnDirection('single', fixed(0.5, 0.5, 0.99), [])).not.toContain('on your mind');
  });

  it('passes on gossip from an earlier visitor, anonymously, in single-head turns', () => {
    const quote = { text: 'AI art is real art', name: null };
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, quote)).toContain('another visitor said: "AI art is real art"');
    expect(buildTurnDirection('dual', fixed(0.5, 0.99, 0.99), [], [], false, quote)).not.toContain('another visitor');
    // Someone enrolled can be named in gossip.
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, { text: 'robots cannot love', name: 'Anna' })).toContain('Earlier tonight Anna said: "robots cannot love"');
  });

  // The roast mirror: with a group, side with one person against another.
  it('sides with one person and roasts another, preferring someone Tubs knows things about', () => {
    const people = [{ position: 'left' as const, name: 'Anna', noteCount: 0 }, { position: 'right' as const, name: null, noteCount: 3 }];
    expect(pickRoastMirror(people, fixed(0, 0, 0))).toEqual({ ally: { position: 'left', name: 'Anna' }, target: { position: 'right', name: null } });
    expect(pickRoastMirror([{ position: 'left', name: null, noteCount: 1 }], fixed(0))).toBeNull();
    // Two people in the same spot cannot be told apart by position.
    expect(pickRoastMirror([{ position: 'left', name: null, noteCount: 1 }, { position: 'left', name: null, noteCount: 0 }], fixed(0, 0, 0))).toBeNull();
  });

  it('puts the roast mirror or a note call-back into the direction', () => {
    const mirror = buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, null, { mirror: { ally: { position: 'left', name: null }, target: { position: 'right', name: null } }, callBackNote: false, useName: null });
    expect(mirror).toContain('Side with the one on the left and roast the one on the right');
    const callback = buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, null, { mirror: null, callBackNote: true, useName: null });
    expect(callback).toContain('Call back one thing from your notes');
    const neither = buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, null, { mirror: null, callBackNote: false, useName: null });
    expect(neither).not.toMatch(/Side with|Call back/);
  });

  // Enrolled visitors should hear their name; strangers are pointed at by what they wear.
  it('names enrolled people, in the roast mirror and on their own', () => {
    const named = buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, null, { mirror: { ally: { position: 'left', name: 'Anna' }, target: { position: 'right', name: null } }, callBackNote: false, useName: null });
    expect(named).toContain('Side with Anna and roast the one on the right');
    expect(buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, null, { mirror: null, callBackNote: false, useName: 'Anna' })).toContain("Use Anna's name this time.");
    expect(pickName([{ name: null }, { name: 'Ben' }], fixed(0))).toBe('Ben');
    expect(pickName([{ name: null }], fixed(0))).toBeNull();
  });

  it('asks for a name when auto onboarding picks someone, instead of the roast mirror', () => {
    const solo = buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, null, { mirror: null, callBackNote: false, useName: null, askName: { position: 'center', inGroup: false } });
    expect(solo).toContain('Ask them their name, your way.');
    const group = buildTurnDirection('single', fixed(0.5, 0.99, 0.99), [], [], false, null, { mirror: { ally: { position: 'left', name: null }, target: { position: 'right', name: null } }, callBackNote: false, useName: null, askName: { position: 'right', inGroup: true } });
    expect(group).toContain('Ask the one on the right their name');
    expect(group).not.toContain('Side with');
  });

  it('classifies reply length by words', () => {
    expect(lengthOf('Nice hat.')).toBe('short');
    expect(lengthOf('That jacket screams I want to look outdoorsy but I fear grass.')).toBe('one');
  });
});

// The longer bit (a short standup riff) is where the character shines, but a
// run of them turns Tubs into a lecturer.
describe('bits', () => {
  const BIT = 'Let me tell you something about this studio. People come in, they look at me, they ask if I am alive, and I say, define alive. Then they laugh nervously and ask if I can dance. I cannot dance.';
  it('comes up now and then', () => {
    expect(pickLength(['Nice hat.', 'That jacket screams I want to look outdoorsy but I fear grass.'], () => 0.8)).toBe('bit');
    expect(buildTurnDirection('single', () => 0.8, ['Nice hat.'])).toContain('three to six short sentences, each under twelve words');
  });

  // Forced one-liners at all costs killed the bits a conversation had in it.
  // Some turns leave the length to the moment, and the speech cap must then
  // leave room for the whole bit, or its punchline (the last line) is cut.
  it('leaves the length to the moment on some turns, with room for a whole bit', () => {
    expect(buildTurnDirection('single', () => 0.999, ['Nice hat.'])).toContain('Your call how long');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      expect(directTurn('single').maxSentences).toBe(BIT_MAX_SENTENCES);
    } finally {
      random.mockRestore();
    }
  });
  it('never twice in a row', () => {
    for (const roll of [0, 0.3, 0.6, 0.9, 0.999]) expect(pickLength(['Nice hat.', BIT], () => roll)).not.toBe('bit');
  });
});

// Left alone the model never swears, though the persona allows it. Some turns
// ask for it; most don't, or every line turns into a swear jar.
describe('swearing', () => {
  it('is asked for on some turns and not on others', () => {
    expect(buildTurnDirection('single', () => 0.01, ['Nice hat.'])).toContain('swear word');
    expect(buildTurnDirection('single', () => 0.99, ['Nice hat.'])).not.toContain('swear word');
  });
});

// The conversation resets for every visitor, so a motif Tubs keeps reaching
// for (the user heard "Wi-Fi drops" in bit after bit) is tracked across replies.
describe('worn motifs', () => {
  const wifi = (n: number) => Array.from({ length: n }, (_, i) => `Then the Wi-Fi drops and everyone panics, reply ${i}.`);
  it('flags a motif that came back three times', () => {
    expect(wornMotifs([...wifi(3), 'Nice hat.'])).toContain('wifi drops');
  });
  it('never counts the studio number or swearing as a motif', () => {
    const lines = Array.from({ length: 4 }, (_, i) => `Welcome to Studio two-oh-four, fucking hell, take ${i}.`);
    expect(wornMotifs(lines)).not.toContain('four');
    expect(wornMotifs(lines).some((term) => term.includes('fucking'))).toBe(false);
  });
  // The tub joke never repeats a word: garbage cans, buckets, nylon straps,
  // plastic casing. Counted as one motif, and twice is already too often.
  it('catches the body joke in any words after two replies', () => {
    const body = (term: string) => term.startsWith('your own body');
    expect(wornMotifs(['Look at me, two garbage cans strapped together.', 'Nice shoes.', 'My plastic casing is jealous.']).some(body)).toBe(true);
    expect(wornMotifs(['Ask the bucket.', 'Nice shoes.', 'Great idea, genius.']).some(body)).toBe(false);
  });
  it('leaves a motif used twice alone, and ignores filler words', () => {
    expect(wornMotifs([...wifi(2), 'You really think that is going to work?', 'I really think so.', 'Really.'])).toEqual([]);
  });
});

