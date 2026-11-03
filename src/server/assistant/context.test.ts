import { describe, expect, it } from 'vitest';
import { getVisualContext, updateVisualContext } from './context.js';

// The camera description is about whoever stood in front of Tubs when the
// frame was taken. It must not outlive them.
describe('visual context', () => {
  it('is used while fresh and dropped after a minute', () => {
    updateVisualContext('red hoodie, holding coffee', 1_000_000);
    expect(getVisualContext(1_000_000 + 30_000)).toBe('red hoodie, holding coffee');
    expect(getVisualContext(1_000_000 + 61_000)).toBe('');
  });
});
