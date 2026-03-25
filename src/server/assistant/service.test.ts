import { describe, expect, it } from 'vitest';
import { isPersonaDrift } from './service.js';

describe('isPersonaDrift', () => {
  it('does not flag a reply just because it lacks a question mark', () => {
    expect(
      isPersonaDrift('This plan is cursed enough to work and I respect the damage it could do.'),
    ).toBeNull();
  });

  it('still flags explicit generic assistant phrasing', () => {
    expect(isPersonaDrift('Certainly. Let me know if you want more help.')).toContain('forbidden phrase');
  });
});
