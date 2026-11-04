import { describe, expect, it } from 'vitest';
import { buildContents, CUT_OFF_MARK, getVisualContext, markLastReplyCutOff, pushHistory, updateVisualContext, wasLastReplyCutOff } from './context.js';

// The camera description is about whoever stood in front of Tubs when the
// frame was taken. It must not outlive them.
describe('visual context', () => {
  it('is used while fresh and dropped after a minute', () => {
    updateVisualContext('red hoodie, holding coffee', 1_000_000);
    expect(getVisualContext(1_000_000 + 30_000)).toBe('red hoodie, holding coffee');
    expect(getVisualContext(1_000_000 + 61_000)).toBe('');
  });
});

// The per-turn direction steers this reply only. If it leaked into history the
// model would read old directions as things visitors said.
describe('turn direction', () => {
  it('rides on the newest user message and never enters history', () => {
    pushHistory('user', 'hi');
    pushHistory('model', 'Hello, meat.');
    const { contents } = buildContents('nice hat', '[Stage direction]\n- One sentence.');
    expect(contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'nice hat' }, { text: '[Stage direction]\n- One sentence.' }] });
    expect(buildContents('next').contents.flatMap((entry) => entry.parts.map((part) => part.text))).not.toContain('[Stage direction]\n- One sentence.');
  });
});

// Without the mark the model assumes its whole line landed and carries on as if
// the visitor heard it.
describe('cut-off replies', () => {
  it('marks the last reply once, and only a reply', () => {
    pushHistory('user', 'tell me about wheels');
    pushHistory('model', 'So there I was, wheel-less, in a Home Depot');
    markLastReplyCutOff();
    markLastReplyCutOff();
    expect(wasLastReplyCutOff()).toBe(true);
    expect(buildContents('anyway').contents.at(-2)?.parts[0]?.text).toBe(`So there I was, wheel-less, in a Home Depot ${CUT_OFF_MARK}`);

    pushHistory('user', 'hello?');
    markLastReplyCutOff();
    expect(wasLastReplyCutOff()).toBe(false);
  });
});
