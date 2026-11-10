// studio_context from the director (sentient-studio contract §6/§8): where the
// heads are in the venue and who is around, rendered into a few plain lines of
// turn context. Places only, never coordinates or ids: Tubs talks about "the
// person by the cinema", not "p2 at 3.5 m". The venue (zones, windows, the
// night's theme) arrives once per connection and on a theme change and stays
// as standing context; the rest is dropped from the prompt once it is stale.

export const STUDIO_CONTEXT_STALE_MS = 10_000;

export type Relation = 'here' | 'same-room' | 'next-room' | 'far';

export interface StudioContextHead {
  zone: string | null;
  window: string | null;
  near: boolean | null;
  mode: string;
  speaking: boolean;
}

export interface StudioContextPerson {
  id: string;
  zone: string | null;
  window: string | null;
  /** From the speaking head's window (else Main's); null without one. Older directors send only metres. */
  relation?: Relation | null;
  /** Metres to that window, for here and same-room. */
  distance: number | null;
  dwell: number;
  engaged: boolean;
  with: 'main' | 'small' | 'both' | null;
}

export interface StudioVenue {
  theme: string | null;
  phase: string | null;
  zones: Array<{ id: string; name: string; about: string }>;
  windows: Array<{ id: string; name: string; zone: string | null; about: string }>;
}

export interface StudioContextMessage {
  reason: string;
  heads: Record<string, StudioContextHead>;
  people: StudioContextPerson[];
  reference: { head: string; window: string } | null;
  venue?: StudioVenue;
  /** the gallery tour while it runs (sentient-studio contract §6): where, the step, and the picture up on screen */
  tour?: StudioTour;
  ts: number;
}

export interface StudioTour {
  where: string;
  step: string;
  stop: number;
  of: number;
  next: string | null;
  piece?: { title: string; date?: string; by?: string; text?: string };
}

/** the director says the tour still runs at least every 20 s; after this long without word it counts as over (ms) */
export const STUDIO_TOUR_STALE_MS = 45_000;

let latest: { context: StudioContextMessage; at: number } | null = null;
let venue: StudioVenue | null = null;
let tour: { tour: StudioTour; at: number } | null = null;

export function noteStudioContext(context: StudioContextMessage, now = Date.now()): void {
  latest = { context, at: now };
  if (context.venue) venue = context.venue;
  // every context while the tour runs carries it; one without it means the tour is over
  tour = context.tour && typeof context.tour.where === 'string' ? { tour: context.tour, at: now } : null;
}

export function forgetStudioContext(): void {
  latest = null;
  venue = null;
  tour = null;
}

/** The gallery tour, while the director says it runs. */
export function studioTour(now = Date.now()): StudioTour | null {
  return tour && now - tour.at <= STUDIO_TOUR_STALE_MS ? tour.tour : null;
}

/**
 * While the tour runs, what every reply is told: that they are guiding it, where, and the picture on
 * screen there with what the archive says of it, so a visitor's question about it gets an answer.
 */
export function renderTour(t: StudioTour | null): string[] {
  if (!t) return [];
  const lines = [`You two are guiding a tour through a gallery of pictures from the Alan Watts archive; you are at the ${t.where} (stop ${t.stop} of ${t.of}${t.next ? `, next the ${t.next}` : ''}), Tubs carrying a little tour-guide flag.`];
  const p = t.piece;
  if (p) {
    lines.push(`On screen here now, pulled up for the visitors: "${p.title}"${p.date ? `, ${p.date}` : ''}${p.by ? `, from the series "${p.by}"` : ''}.${p.text ? ` What it shows: ${p.text}` : ''} A visitor's question now is most likely about it; say only what the archive supports.`);
  }
  return lines;
}

/** The latest context while it is fresh (and the venue), for decisions like a call-out. */
export function freshStudioContext(now = Date.now()): { context: StudioContextMessage; venue: StudioVenue | null } | null {
  return latest && now - latest.at <= STUDIO_CONTEXT_STALE_MS ? { context: latest.context, venue } : null;
}

/**
 * For a conversation Tubs starts himself: a short call-out naming where the
 * person is, when nobody is right in front of the window ("Hey, you over by
 * the cinema!"). Null when someone is close, nobody is known, or the place is.
 */
export function calloutLine(context: StudioContextMessage, v: StudioVenue | null, pick: (count: number) => number = (count) => Math.floor(Math.random() * count)): string | null {
  const referenceZone = context.reference ? context.heads[context.reference.head]?.zone ?? null : context.heads.main?.zone ?? null;
  const people = context.people.map((person) => ({ person, ...relationOf(person, referenceZone) }));
  if (people.length === 0 || people.some((entry) => entry.relation === 'here')) return null;
  const rank = (relation: Relation | null) => (relation === 'same-room' ? 0 : relation === 'next-room' ? 1 : relation === 'far' ? 2 : 3);
  const target = [...people].sort((a, b) => rank(a.relation) - rank(b.relation) || b.person.dwell - a.person.dwell)[0]!;
  const place = nameOfZone(target.person.zone, v) ?? nameOfWindow(target.person.window, v);
  if (!place) return null;
  const at = the(place);
  const lines = [`Hey, you over by ${at}!`, `Psst! You, by ${at}!`, `Hey! Yes, you, over by ${at}!`, `You there, by ${at}!`];
  return lines[pick(lines.length) % lines.length]!;
}

/** The lines for the prompt now: the standing venue lines, plus the latest context while it is fresh. */
export function studioContextLines(now = Date.now()): string[] {
  const fresh = latest && now - latest.at <= STUDIO_CONTEXT_STALE_MS ? latest.context : null;
  return [...renderTour(studioTour(now)), ...renderStudioPresence(fresh, venue), ...renderVenue(venue)];
}

/** How the characters talk about the venue, in studio mode. */
export const STUDIO_PERSONA_LINE = 'You speak in places ("over by the cinema", "the one at the Book"), never in numbers or coordinates. You can move through the walls of the otherside to any window.';

// ---- rendering (pure) ----

function nameOfWindow(id: string | null, v: StudioVenue | null): string | null {
  if (!id) return null;
  return v?.windows.find((window) => window.id === id)?.name ?? humanize(id);
}

function nameOfZone(id: string | null, v: StudioVenue | null): string | null {
  if (!id) return null;
  return v?.zones.find((zone) => zone.id === id)?.name ?? humanize(id);
}

/** "photo-booth" -> "photo booth": ids are never shown as ids. */
function humanize(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const the = (name: string) => (/^the\s/i.test(name) ? name : `the ${name}`);

export function relationOf(person: StudioContextPerson, referenceZone: string | null): { relation: Relation | null; metres: number | null } {
  const metres = typeof person.distance === 'number' && Number.isFinite(person.distance) ? person.distance : null;
  const given = asRelation(person.relation);
  if (given) return { relation: given, metres: given === 'here' || given === 'same-room' ? metres : null };
  // Older directors: metres only.
  if (metres !== null) {
    if (metres <= 1.5) return { relation: 'here', metres };
    return { relation: person.zone && referenceZone && person.zone !== referenceZone ? 'next-room' : 'same-room', metres };
  }
  if (person.zone && referenceZone && person.zone !== referenceZone) return { relation: 'next-room', metres: null };
  return { relation: null, metres: null };
}

function asRelation(value: unknown): Relation | null {
  return value === 'here' || value === 'same-room' || value === 'next-room' || value === 'far' ? value : null;
}

/** Rough metres in words: "a couple of metres", "about 5 m". */
function roughMetres(metres: number): string {
  if (metres < 2.5) return 'a couple of metres';
  return `about ${Math.round(metres)} m`;
}

/** Dwell in rough words: never a precise count. */
function roughDwell(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 8) return 'just now';
  if (seconds < 60) return `for about ${Math.max(10, Math.round(seconds / 10) * 10)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? 'for about a minute' : `for about ${minutes} minutes`;
}

export function renderStudioPresence(context: StudioContextMessage | null, v: StudioVenue | null): string[] {
  if (!context) return [];
  const lines: string[] = [];
  const main = context.heads.main;
  const small = context.heads.small;
  if (main) {
    const window = nameOfWindow(main.window, v);
    const zone = nameOfZone(main.zone, v);
    let line = window
      ? `You are behind ${the(window)}${zone ? `, next to ${the(zone)}` : ''}${main.near === false ? ', a little back from the glass' : ''}`
      : 'You are moving between windows';
    if (small) {
      if (!small.window) line += '; Small is moving between windows';
      else if (small.window === main.window) line += '; Small is beside you';
      else if (small.zone && small.zone === main.zone) line += `; Small is at ${the(nameOfWindow(small.window, v)!)}, nearby`;
      else line += `; Small is over by ${the(nameOfZone(small.zone, v) ?? nameOfWindow(small.window, v)!)}`;
    }
    lines.push(`${line}.`);
  }

  const referenceZone = context.reference ? context.heads[context.reference.head]?.zone ?? null : main?.zone ?? null;
  const people = [...context.people].sort((a, b) => Number(b.engaged) - Number(a.engaged) || b.dwell - a.dwell).slice(0, 4);
  let first = true;
  for (const person of people) {
    const who = first ? 'Someone' : 'Another person';
    first = false;
    const { relation, metres } = relationOf(person, referenceZone);
    const zone = nameOfZone(person.zone, v);
    const window = nameOfWindow(person.window, v);
    const talking = person.engaged
      ? person.with === 'small' ? ', talking with Small' : person.with === 'both' ? ', talking with you both' : ', the one you\'re talking to'
      : '';
    switch (relation) {
      case 'here':
        lines.push(`${who} has been standing right in front of you ${roughDwell(person.dwell)}${talking}.`);
        break;
      case 'same-room':
        lines.push(`${who} is ${metres !== null ? `${roughMetres(metres)} away` : 'nearby'}${window ? ` at ${the(window)}` : zone ? ` in ${the(zone)}` : ''}${talking}.`);
        break;
      case 'next-room':
        lines.push(`${who} is in ${zone ? the(zone) : 'the room'} next door${talking}.`);
        break;
      case 'far':
        lines.push(`${who} is far off${zone ? `, over by ${the(zone)}` : ''}${talking}.`);
        break;
      default:
        lines.push(`${who} is ${window ? `at ${the(window)}` : zone ? `in ${the(zone)}` : 'around'}${talking}.`);
    }
  }
  const more = context.people.length - people.length;
  if (more > 0) lines.push(`${more} more ${more === 1 ? 'person is' : 'people are'} around.`);
  return lines;
}

export function renderVenue(v: StudioVenue | null): string[] {
  if (!v) return [];
  const lines: string[] = [];
  if (v.theme) lines.push(`Tonight's theme: ${v.theme}${v.phase ? ` (${v.phase})` : ''}.`);
  for (const zone of v.zones.slice(0, 8)) {
    if (zone.about) lines.push(`${zone.name}: ${zone.about}`);
  }
  for (const window of v.windows.slice(0, 12)) {
    if (window.about) lines.push(`${window.name}${window.zone ? ` (in ${the(nameOfZone(window.zone, v)!)})` : ''}: ${window.about}`);
  }
  return lines;
}
