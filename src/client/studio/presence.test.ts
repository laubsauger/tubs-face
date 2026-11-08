import { describe, expect, it } from 'vitest';
import { FORGET_AFTER_MS } from '../face/visitor-tracker.js';
import { createStudioPresence } from './presence.js';

// In the studio the director sees people, not a camera on the face page. Its
// presence has to mean what the camera's means: someone there keeps Tubs
// awake and lets him speak up; nobody for a few minutes ends the visit, so
// the next person isn't greeted as the last one.
describe('studio presence', () => {
  it('counts people near either head, once (both windows can see the same people)', () => {
    const presence = createStudioPresence();
    expect(presence.update('main', true, 2, 0)).toBe(2);
    expect(presence.update('small', true, 1, 0)).toBe(2);
    expect(presence.update('main', false, undefined, 0)).toBe(1);
    expect(presence.update('small', false, 0, 0)).toBe(0);
  });

  it('takes present without a count as someone, and a count without present as nobody', () => {
    const presence = createStudioPresence();
    expect(presence.update('main', true, undefined, 0)).toBe(1);
    expect(presence.update('main', false, 3, 0)).toBe(0);
  });

  it('ends the visit only after nobody was there for the camera\'s forget time', () => {
    const presence = createStudioPresence();
    presence.update('main', true, 1, 0);
    presence.update('main', false, 0, 1000);
    expect(presence.visitOver(1000 + FORGET_AFTER_MS - 1)).toBe(false);
    expect(presence.visitOver(1000 + FORGET_AFTER_MS)).toBe(true);
    // Once.
    expect(presence.visitOver(1000 + FORGET_AFTER_MS * 2)).toBe(false);
  });

  it('keeps the visit when someone steps back in before then', () => {
    const presence = createStudioPresence();
    presence.update('main', true, 1, 0);
    presence.update('main', false, 0, 1000);
    presence.update('small', true, 1, 60_000);
    expect(presence.visitOver(1000 + FORGET_AFTER_MS * 2)).toBe(false);
  });

  it('has no visit to end before anyone came', () => {
    const presence = createStudioPresence();
    presence.update('main', false, 0, 0);
    expect(presence.visitOver(FORGET_AFTER_MS * 5)).toBe(false);
  });
});
