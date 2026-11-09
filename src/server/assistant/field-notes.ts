/**
 * Tubs's field notes on tonight's visitors. When he learns something worth
 * remembering, his reply carries a hidden [[NOTE: ...]] (and sometimes a
 * [[QUOTE: ...]]); no extra LLM call. With several people in view he says
 * who it is about ([[NOTE left: ...]]), positions as in the camera
 * description. Notes are kept per person id from the face tracker, so someone
 * back hours later is remembered; they reach the prompt through the persona's
 * MEMORY_CONTEXT slot. Quotes from people no longer in view feed gossip.
 * Memory only: nothing is written to disk, and notes older than NOTES_TTL_MS
 * are dropped.
 */

export type Position = 'left' | 'center' | 'right';

export interface PersonInView {
  id: string;
  names: string[];
  position: Position;
  awayMs?: number;
  /** Face snapshots the face page holds for auto-onboarding. */
  snapshots?: number;
  /** The first of those snapshots (a small JPEG data URL), for the memory view. */
  thumbnail?: string;
}

const TAG_RE = /\[\[\s*(NOTE|QUOTE|NAME)(?:\s+(left|center|centre|middle|right))?\s*:\s*([^\]]*?)\s*\]\]/gi;
/** Talked with this many turns before Tubs asks an unnamed person their name. */
const ASK_NAME_AFTER_TURNS = 2;
const MAX_NOTES_PER_PERSON = 10;
const MAX_PEOPLE = 300;
const MAX_QUOTES = 20;
const MAX_NOTE_CHARS = 120;
export const NOTES_TTL_MS = 12 * 3600_000;
/** Back after this long, they count as returning ("you met them earlier tonight"). */
const RETURNING_AFTER_MS = 3 * 60_000;
// Camera off: notes still help within one conversation.
const ANONYMOUS = '';
// Several people and the note does not say who: it belongs to this visit's group.
const GROUP = '#group';

interface PersonRecord {
  notes: string[];
  names: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  returning: boolean;
  /** In the face library (recognised by name, or just auto-enrolled). */
  enrolled: boolean;
  snapshots: number;
  turns: number;
  askedName: boolean;
  /** Their face when first snapshotted tonight (memory only, like the notes). */
  thumbnail: string | null;
}

interface QuoteRecord {
  personId: string;
  text: string;
  at: number;
}

const records = new Map<string, PersonRecord>();
const quotes: QuoteRecord[] = [];
let inView: PersonInView[] = [];
let changeListener: (() => void) | null = null;
let enrollListener: ((personId: string, name: string) => void) | null = null;

/** Called when someone told Tubs their name and the face page can enroll them. */
export function onEnrollRequest(listener: ((personId: string, name: string) => void) | null): void {
  enrollListener = listener;
}

/** Called when the people in view or their notes change (the server broadcasts to the operator panel). */
export function onFieldNotesChange(listener: (() => void) | null): void {
  changeListener = listener;
}

function clean(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim().slice(0, MAX_NOTE_CHARS);
}

function normalizePosition(value: string | undefined): Position | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return lower === 'left' || lower === 'right' ? lower : 'center';
}

/** The note and quote tags in a raw reply (dual-head JSON included). */
export function extractFieldNotes(rawText: string): Array<{ kind: 'note' | 'quote' | 'name'; position: Position | null; text: string }> {
  const found: Array<{ kind: 'note' | 'quote' | 'name'; position: Position | null; text: string }> = [];
  for (const match of String(rawText).matchAll(TAG_RE)) {
    const text = clean(match[3] ?? '');
    if (!text) continue;
    const kind = match[1]!.toLowerCase() as 'note' | 'quote' | 'name';
    found.push({ kind, position: normalizePosition(match[2]), text });
  }
  return found;
}

function prune(now: number): void {
  for (const [id, record] of records) {
    if (now - record.lastSeenAt > NOTES_TTL_MS) records.delete(id);
  }
  while (quotes.length > 0 && now - quotes[0]!.at > NOTES_TTL_MS) quotes.shift();
}

function recordFor(id: string, now: number): PersonRecord {
  let record = records.get(id);
  if (!record) {
    record = { notes: [], names: [], firstSeenAt: now, lastSeenAt: now, returning: false, enrolled: false, snapshots: 0, turns: 0, askedName: false, thumbnail: null };
    records.set(id, record);
    if (records.size > MAX_PEOPLE) {
      const oldest = [...records.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (oldest) records.delete(oldest[0]);
    }
  }
  return record;
}

/** The face tracker says who is in view, left to right. */
export function setPeople(people: PersonInView[], now = Date.now()): void {
  prune(now);
  for (const person of people) {
    const existing = records.get(person.id);
    const record = recordFor(person.id, now);
    const back = person.awayMs !== undefined ? person.awayMs >= RETURNING_AFTER_MS : Boolean(existing && now - existing.lastSeenAt >= RETURNING_AFTER_MS);
    if (back) record.returning = true;
    record.lastSeenAt = now;
    record.snapshots = person.snapshots ?? 0;
    if (person.thumbnail && !record.thumbnail) record.thumbnail = person.thumbnail;
    // Names from the tracker come from the face library.
    if (person.names.length > 0) record.enrolled = true;
    for (const name of person.names) if (!record.names.includes(name)) record.names.push(name);
  }
  inView = people.map((person) => ({ id: person.id, names: person.names, position: person.position }));
  changeListener?.();
}

/** The visit is over: anonymous and group notes go with the conversation. */
export function endVisit(): void {
  records.delete(ANONYMOUS);
  records.delete(GROUP);
  changeListener?.();
}

/** Who a note is about: by position, the only person in view, or the group. */
function ownerOf(position: Position | null): string {
  if (inView.length === 0) return ANONYMOUS;
  if (inView.length === 1) return inView[0]!.id;
  if (position) {
    const atPosition = inView.filter((person) => person.position === position);
    if (atPosition.length === 1) return atPosition[0]!.id;
  }
  return GROUP;
}

function addFacts(record: PersonRecord, note: string): boolean {
  let changed = false;
  // The model tends to repeat its whole list ("dentist, hates jazz, from
  // Berlin"); keep single facts and merge overlaps instead of piling up.
  for (const fact of note.split(/\s*[,;]\s*/).map((part) => part.trim()).filter(Boolean)) {
    const lower = fact.toLowerCase();
    if (record.notes.some((existing) => existing.toLowerCase().includes(lower))) continue;
    const narrower = record.notes.findIndex((existing) => lower.includes(existing.toLowerCase()));
    if (narrower !== -1) record.notes.splice(narrower, 1);
    record.notes.push(fact);
    changed = true;
  }
  if (record.notes.length > MAX_NOTES_PER_PERSON) record.notes.splice(0, record.notes.length - MAX_NOTES_PER_PERSON);
  return changed;
}

/** Stores the tags of one reply. True when something new was noted. */
export function recordFieldNotes(rawText: string, now = Date.now()): boolean {
  const tags = extractFieldNotes(rawText);
  if (tags.length === 0) return false;
  let changed = false;
  for (const tag of tags) {
    const owner = ownerOf(tag.position);
    if (tag.kind === 'note') {
      const record = recordFor(owner, now);
      record.lastSeenAt = now;
      changed = addFacts(record, tag.text) || changed;
    } else if (tag.kind === 'name') {
      if (owner === ANONYMOUS || owner === GROUP) continue;
      const record = recordFor(owner, now);
      if (!record.names.includes(tag.text)) {
        record.names.unshift(tag.text);
        changed = true;
      }
      // Told their name with snapshots ready: remember their face from now on.
      if (!record.enrolled && record.snapshots > 0) {
        record.enrolled = true;
        enrollListener?.(owner, tag.text);
      }
    } else if (!quotes.some((quote) => quote.text === tag.text)) {
      quotes.push({ personId: owner, text: tag.text, at: now });
      changed = true;
    }
  }
  if (quotes.length > MAX_QUOTES) quotes.splice(0, quotes.length - MAX_QUOTES);
  if (changed) changeListener?.();
  return changed;
}

const POSITION_WORDS: Record<Position, string> = { left: 'On the left', center: 'In the middle', right: 'On the right' };

function describe(record: PersonRecord | undefined): string {
  if (!record) return 'nothing yet';
  const bits = [
    ...(record.names.length > 0 ? [`name ${record.names.join('/')}`] : []),
    ...(record.returning ? ['met earlier tonight'] : []),
    ...record.notes,
  ];
  return bits.length > 0 ? bits.join('; ') : 'nothing yet';
}

/** What goes into the prompt's MEMORY_CONTEXT slot for the people in view. */
export function memoryContext(now = Date.now()): string {
  prune(now);
  const usage = 'Your own private notes. Bring them up only when the stage direction asks or they are directly relevant, and never read them out as a list.';
  if (inView.length <= 1) {
    const record = records.get(inView[0]?.id ?? ANONYMOUS);
    if (!record || (record.notes.length === 0 && record.names.length === 0)) return '';
    const lines = ['# YOUR FIELD NOTES ON THE PERSON IN FRONT OF YOU', usage];
    if (record.returning) lines.push('You met them earlier tonight. Act like it.');
    if (record.names.length > 0) lines.push(`Name: ${record.names.join(', ')}.`);
    for (const note of record.notes) lines.push(`- ${note}`);
    return lines.join('\n');
  }
  const lines = [`# YOUR FIELD NOTES ON THE ${inView.length} PEOPLE IN FRONT OF YOU (left to right, as the camera sees them)`, usage];
  for (const person of inView) lines.push(`- ${POSITION_WORDS[person.position]}: ${describe(records.get(person.id))}`);
  const group = records.get(GROUP);
  if (group && group.notes.length > 0) lines.push(`- About the group: ${group.notes.join('; ')}`);
  return lines.join('\n');
}

/** A recent quote from someone not in view, for gossip. */
export function pickGossip(random: () => number = Math.random, now = Date.now()): { text: string; name: string | null } | null {
  prune(now);
  const here = new Set([ANONYMOUS, GROUP, ...inView.map((person) => person.id)]);
  const others = quotes.filter((quote) => !here.has(quote.personId));
  if (others.length === 0) return null;
  const quote = others[Math.floor(random() * others.length)]!;
  // Enrolled people can be named; everyone else stays anonymous.
  return { text: quote.text, name: records.get(quote.personId)?.names[0] ?? null };
}

/** Who is in view: where, their name if enrolled, and how much Tubs knows about them. */
export function peopleInView(): Array<{ position: Position; name: string | null; noteCount: number }> {
  return inView.map((person) => {
    const record = records.get(person.id);
    return { position: person.position, name: record?.names[0] ?? person.names[0] ?? null, noteCount: record?.notes.length ?? 0 };
  });
}

/** A user turn happened: everyone in view has now talked with Tubs a bit more. */
export function noteTurn(): void {
  for (const person of inView) {
    const record = records.get(person.id);
    if (record) record.turns += 1;
  }
}

/** Someone unnamed Tubs has talked with a while and can enroll: time to ask their name. */
export function nameAskCandidate(): { position: Position; inGroup: boolean } | null {
  const person = inView.find((candidate) => {
    const record = records.get(candidate.id);
    return record && !record.enrolled && record.names.length === 0 && record.snapshots > 0 && record.turns >= ASK_NAME_AFTER_TURNS && !record.askedName;
  });
  return person ? { position: person.position, inGroup: inView.length > 1 } : null;
}

/** Asked once per person, so it does not become a routine. */
export function markNameAsked(position: Position): void {
  const person = inView.find((candidate) => candidate.position === position);
  const record = person ? records.get(person.id) : undefined;
  if (record) record.askedName = true;
}

/** True when the people in view have any notes (for "call back a note"). */
export function hasNotesInView(): boolean {
  if (inView.length === 0) return (records.get(ANONYMOUS)?.notes.length ?? 0) > 0;
  return inView.some((person) => (records.get(person.id)?.notes.length ?? 0) > 0);
}

export interface FieldNotesSnapshot {
  people: Array<{ id: string; position: Position; names: string[]; returning: boolean; notes: string[] }>;
  groupNotes: string[];
  quotes: string[];
}

/** For the operator panel. */
export function fieldNotesSnapshot(now = Date.now()): FieldNotesSnapshot {
  prune(now);
  const people = inView.length > 0
    ? inView.map((person) => {
      const record = records.get(person.id);
      return { id: person.id, position: person.position, names: record?.names ?? person.names, returning: record?.returning ?? false, notes: record?.notes ?? [] };
    })
    : (records.get(ANONYMOUS)?.notes.length ? [{ id: 'no-camera', position: 'center' as const, names: [], returning: false, notes: records.get(ANONYMOUS)!.notes }] : []);
  return {
    people,
    groupNotes: records.get(GROUP)?.notes ?? [],
    quotes: quotes.slice(-8).map((quote) => quote.text).reverse(),
  };
}

export interface PersonMemory {
  id: string;
  names: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  returning: boolean;
  turns: number;
  notes: string[];
  quotes: string[];
  thumbnail: string | null;
  /** Where they are, while in view. */
  position: Position | null;
}

/** Everyone noted tonight, in view or not, for the memory view. */
export function tonightsPeople(now = Date.now()): { people: PersonMemory[]; groupNotes: string[]; unattributedNotes: string[] } {
  prune(now);
  const people: PersonMemory[] = [];
  for (const [id, record] of records) {
    if (id === ANONYMOUS || id === GROUP) continue;
    people.push({
      id,
      names: [...record.names],
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      returning: record.returning,
      turns: record.turns,
      notes: [...record.notes],
      quotes: quotes.filter((quote) => quote.personId === id).map((quote) => quote.text),
      thumbnail: record.thumbnail,
      position: inView.find((person) => person.id === id)?.position ?? null,
    });
  }
  return { people, groupNotes: [...(records.get(GROUP)?.notes ?? [])], unattributedNotes: [...(records.get(ANONYMOUS)?.notes ?? [])] };
}

/** The operator forgets these people for tonight: their notes, quotes and snapshot. */
export function forgetPeople(ids: readonly string[]): number {
  let forgotten = 0;
  for (const id of ids) {
    if (id === ANONYMOUS || id === GROUP) continue;
    if (records.delete(id)) forgotten += 1;
    for (let i = quotes.length - 1; i >= 0; i -= 1) if (quotes[i]!.personId === id) quotes.splice(i, 1);
  }
  if (forgotten > 0) changeListener?.();
  return forgotten;
}

/** The operator clears tonight's notes: everything Tubs noted, about anyone. */
export function clearTonight(): void {
  records.clear();
  quotes.length = 0;
  changeListener?.();
}

/** Test helper. */
export function resetFieldNotes(): void {
  records.clear();
  quotes.length = 0;
  inView = [];
}

/**
 * Streams arrive token by token; a tag can be cut in half by the sentence
 * splitter and then spoken ("NOTE works in marketing"). This holds text back
 * from an opening [[ until its ]] arrives and drops the whole tag.
 */
export function createTagFilter(): { push(delta: string): string; flush(): string } {
  let held = '';
  return {
    push(delta) {
      held += delta;
      let out = '';
      while (held) {
        const open = held.indexOf('[[');
        if (open === -1) {
          // A single trailing "[" may be the start of a tag.
          const keep = held.endsWith('[') ? 1 : 0;
          out += held.slice(0, held.length - keep);
          held = held.slice(held.length - keep);
          break;
        }
        out += held.slice(0, open);
        const close = held.indexOf(']]', open);
        if (close === -1) {
          held = held.slice(open);
          break;
        }
        held = held.slice(close + 2);
      }
      return out;
    },
    flush() {
      // An unclosed tag at the very end is dropped rather than spoken.
      const rest = held.startsWith('[[') ? '' : held;
      held = '';
      return rest;
    },
  };
}
