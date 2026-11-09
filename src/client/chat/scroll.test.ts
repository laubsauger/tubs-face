import { describe, expect, it } from 'vitest';
import type { ChatEntry } from '../state/app-state.js';
import { chatTailKey, nearBottom, STICK_PX } from './scroll.js';

const entry = (id: string, text: string, draft = false): ChatEntry => ({ id, type: 'out', actor: 'main', text, ts: 1, draft });

describe('chat log follows the newest line', () => {
  it('moves when a draft is replaced by its final line, though the count stays the same', () => {
    const before = [entry('a', 'Hello.'), entry('d', 'Uh,', true)];
    const after = [entry('a', 'Hello.'), entry('f', 'Uh, well. Are we restarting?')];
    expect(chatTailKey(after)).not.toBe(chatTailKey(before));
  });

  it('moves while the newest line grows', () => {
    expect(chatTailKey([entry('d', 'Uh,', true)])).not.toBe(chatTailKey([entry('d', 'Uh, well.', true)]));
  });

  it('stays when nothing at the end changed', () => {
    const list = [entry('a', 'Hello.'), entry('b', 'Hi.')];
    expect(chatTailKey([...list])).toBe(chatTailKey(list));
  });

  it('keeps a reader who scrolled up where they are', () => {
    expect(nearBottom(2000, 2000 - 400, 400)).toBe(true);
    expect(nearBottom(2000, 2000 - 400 - STICK_PX, 400)).toBe(true);
    expect(nearBottom(2000, 900, 400)).toBe(false);
  });
});
