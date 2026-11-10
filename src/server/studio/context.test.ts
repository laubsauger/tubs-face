import { afterEach, describe, expect, it } from 'vitest';
import { STUDIO_TOUR_STALE_MS, forgetStudioContext, noteStudioContext, studioContextLines, studioGroupShow, studioScreening, studioTour, type StudioContextMessage, type StudioVenue } from './context.js';

// The director tells Tubs where he is and who is around. The model must get
// that as places a host would talk about ("by the cinema"), never as ids or
// coordinates, which it would read out or reason about as numbers.

const venue: StudioVenue = {
  theme: 'Night of the deep sea',
  phase: 'opening',
  zones: [
    { id: 'pb', name: 'photobooth', about: 'a booth with a curtain and props' },
    { id: 'gal', name: 'gallery', about: 'framed prints along the wall' },
    { id: 'cin', name: 'cinema', about: 'a dark room with a screen' },
  ],
  windows: [
    { id: 'book', name: 'Book', zone: 'pb', about: 'a frame shaped like an open book' },
    { id: 'g3', name: 'Mirror', zone: 'pb', about: 'a tall mirror frame' },
  ],
};

const context = (overrides: Partial<StudioContextMessage> = {}): StudioContextMessage => ({
  reason: 'turn',
  heads: {
    main: { zone: 'pb', window: 'book', near: true, mode: 'engaged', speaking: false },
    small: { zone: 'pb', window: 'book', near: true, mode: 'attended', speaking: false },
  },
  people: [
    { id: 'p1', zone: 'pb', window: 'book', relation: 'here', distance: 0.8, dwell: 21.4, engaged: true, with: 'main' },
    { id: 'p2', zone: 'gal', window: null, relation: 'next-room', distance: null, dwell: 4, engaged: false, with: null },
    { id: 'p7', zone: 'pb', window: 'g3', relation: 'same-room', distance: 3.5, dwell: 95, engaged: false, with: null },
    { id: 'p9', zone: 'cin', window: null, relation: 'far', distance: null, dwell: 2, engaged: false, with: null },
  ],
  reference: { head: 'main', window: 'book' },
  venue,
  ts: 1792000000123,
  ...overrides,
});

afterEach(() => forgetStudioContext());

describe('studio context in the prompt', () => {
  it('reads as places, with no ids, coordinates or exact numbers', () => {
    noteStudioContext(context(), 1000);
    const text = studioContextLines(1000).join('\n');
    expect(text).toContain('You are behind the Book, next to the photobooth; Small is beside you.');
    expect(text).toContain('Someone has been standing right in front of you for about 20 s, the one you\'re talking to.');
    expect(text).toContain('in the gallery next door');
    expect(text).toContain('about 4 m away at the Mirror');
    expect(text).toContain('far off, over by the cinema');
    // No person or window ids, no decimals, no timestamps.
    for (const id of ['p1', 'p2', 'p7', 'p9', 'g3', 'gal', 'cin']) expect(text).not.toMatch(new RegExp(`\\b${id}\\b`));
    expect(text).not.toMatch(/\d+\.\d+/);
    expect(text).not.toMatch(/\d{4,}/);
  });

  it('drops the director\'s picture of the room once it is stale, but keeps the venue', () => {
    noteStudioContext(context(), 1000);
    expect(studioContextLines(1000 + 9_000).join('\n')).toContain('right in front of you');
    // More than 10 s old: the people may well have moved.
    const later = studioContextLines(1000 + 10_001).join('\n');
    expect(later).not.toContain('right in front of you');
    expect(later).toContain('Night of the deep sea');
  });

  it('keeps the venue from the first message when later ones come without it', () => {
    noteStudioContext(context(), 1000);
    const { venue: _venue, ...withoutVenue } = context({ heads: { main: { zone: 'cin', window: null, near: null, mode: 'idle', speaking: false } }, people: [] });
    noteStudioContext(withoutVenue, 2000);
    const text = studioContextLines(2000).join('\n');
    expect(text).toContain('You are moving between windows.');
    expect(text).toContain('photobooth: a booth with a curtain and props');
  });

  it('takes metres alone from an older director', () => {
    noteStudioContext(context({ people: [{ id: 'p1', zone: 'pb', window: 'book', distance: 0.8, dwell: 30, engaged: false, with: null }] }), 0);
    expect(studioContextLines(0).join('\n')).toContain('right in front of you');
  });

  it('works without a venue, from the ids made readable', () => {
    const { venue: _unused, ...bare } = context();
    noteStudioContext({ ...bare, heads: { main: { zone: 'photo-booth', window: 'big_book', near: true, mode: 'engaged', speaking: true } } }, 0);
    expect(studioContextLines(0)[0]).toBe('You are behind the big book, next to the photo booth.');
  });

  // Seen live: a visitor asked about the picture on screen and Tubs did not know which one it was.
  it('on the gallery tour every reply knows where the tour is and which picture is up', () => {
    const now = 1_000_000;
    noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: now, tour: { where: 'Big Wall', step: 'floor', stop: 2, of: 5, next: 'Book', piece: { title: 'Haiku session, 1958', date: '1958', by: 'Haiku recording 1958', text: 'Watts at a microphone with musicians.' } } }, now);
    const text = studioContextLines(now).join('\n');
    expect(text).toContain('guiding a tour');
    expect(text).toContain('at the Big Wall');
    expect(text).toContain('"Haiku session, 1958", 1958');
    expect(text).toContain('Watts at a microphone with musicians.');
    // it still runs between the director's beats; a context without it ends it; silence ends it too
    expect(studioTour(now + STUDIO_TOUR_STALE_MS - 1)).not.toBeNull();
    expect(studioTour(now + STUDIO_TOUR_STALE_MS + 1)).toBeNull();
    noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: now + 1000 }, now + 1000);
    expect(studioTour(now + 1000)).toBeNull();
    expect(studioContextLines(now + 1000).join('\n')).not.toContain('guiding a tour');
  });

  // The screening: every screen plays the same shot, so a visitor asking "what's that?" means it.
  it('during the screening every reply knows the film and the shot on every screen', () => {
    const now = 2_000_000;
    const screening = { film: 'Dimination', about: 'A town where every face is Dimi\'s.', host: false, where: null, shot: { title: 'The bus stop', date: '03:14', text: 'Dimi at a request stop in the rain.' }, n: 14, of: 33 };
    noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: now, screening }, now);
    const text = studioContextLines(now).join('\n');
    expect(text).toContain('plays the film "Dimination"');
    expect(text).toContain('shot 14 of 33: "The bus stop", 03:14 into the film');
    expect(text).toContain('Dimi at a request stop in the rain.');
    expect(text).not.toContain('commentary');
    // only a hosted screening is a group show (no greetings, no resets); the plain broadcast is a normal night
    expect(studioGroupShow(now)).toBe(false);
    noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: now, screening: { ...screening, host: true, where: 'Big Wall' } }, now);
    expect(studioGroupShow(now)).toBe(true);
    expect(studioContextLines(now).join('\n')).toContain("director's commentary at the Big Wall");
    // a context without it ends it
    noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: now + 1000 }, now + 1000);
    expect(studioScreening(now + 1000)).toBeNull();
    expect(studioGroupShow(now + 1000)).toBe(false);
  });
});
