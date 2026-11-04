/**
 * Tubs's field notes on tonight's visitors. When he learns something worth
 * remembering, his reply carries a hidden [[NOTE: ...]] (and sometimes a
 * [[QUOTE: ...]]); no extra LLM call. Notes are kept per visitor id from the
 * face tracker, so someone back hours later is remembered, and they reach the
 * prompt through the persona's MEMORY_CONTEXT slot. Quotes from other
 * visitors feed gossip. Memory only: nothing is written to disk, and notes
 * older than NOTES_TTL_MS are dropped.
 */

const TAG_RE = /\[\[\s*(NOTE|QUOTE)\s*:\s*([^\]]*?)\s*\]\]/gi;
const MAX_NOTES_PER_VISITOR = 10;
const MAX_VISITORS = 200;
const MAX_QUOTES = 20;
const MAX_NOTE_CHARS = 120;
export const NOTES_TTL_MS = 12 * 3600_000;
/** Back after this long, they count as returning ("you met them earlier tonight"). */
const RETURNING_AFTER_MS = 3 * 60_000;
// Without camera ids, notes still help within one conversation.
const ANONYMOUS = '';

interface VisitorRecord {
  notes: string[];
  names: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  returning: boolean;
}

interface QuoteRecord {
  visitorId: string;
  text: string;
  at: number;
}

const visitors = new Map<string, VisitorRecord>();
let changeListener: (() => void) | null = null;

/** Called when the current visitor or their notes change (the server broadcasts to the operator panel). */
export function onFieldNotesChange(listener: (() => void) | null): void {
  changeListener = listener;
}
const quotes: QuoteRecord[] = [];
let currentVisitorId = ANONYMOUS;

function clean(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim().slice(0, MAX_NOTE_CHARS);
}

/** The note and quote tags in a raw reply (dual-head JSON included). */
export function extractFieldNotes(rawText: string): { notes: string[]; quotes: string[] } {
  const found = { notes: [] as string[], quotes: [] as string[] };
  for (const match of String(rawText).matchAll(TAG_RE)) {
    const text = clean(match[2] ?? '');
    if (!text) continue;
    (match[1]!.toUpperCase() === 'NOTE' ? found.notes : found.quotes).push(text);
  }
  return found;
}

/** Removes note and quote tags; other [[...]] markers (SHOW_QR) stay. */
export function stripFieldNoteTags(text: string): string {
  return String(text).replace(TAG_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function prune(now: number): void {
  for (const [id, record] of visitors) {
    if (now - record.lastSeenAt > NOTES_TTL_MS) visitors.delete(id);
  }
  while (quotes.length > 0 && now - quotes[0]!.at > NOTES_TTL_MS) quotes.shift();
}

function recordFor(id: string, now: number): VisitorRecord {
  let record = visitors.get(id);
  if (!record) {
    record = { notes: [], names: [], firstSeenAt: now, lastSeenAt: now, returning: false };
    visitors.set(id, record);
    if (visitors.size > MAX_VISITORS) {
      const oldest = [...visitors.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (oldest) visitors.delete(oldest[0]);
    }
  }
  return record;
}

/** The face tracker says who is in front of Tubs now (null: nobody known). */
export function setCurrentVisitor(visitorId: string | null, names: string[] = [], now = Date.now()): void {
  prune(now);
  currentVisitorId = visitorId ?? ANONYMOUS;
  if (!visitorId) {
    changeListener?.();
    return;
  }
  const existing = visitors.get(visitorId);
  const record = recordFor(visitorId, now);
  record.returning = Boolean(existing && now - existing.lastSeenAt >= RETURNING_AFTER_MS);
  record.lastSeenAt = now;
  for (const name of names) if (!record.names.includes(name)) record.names.push(name);
  changeListener?.();
}

/** The visitor left or was replaced: anonymous notes go with the conversation. */
export function endVisit(): void {
  visitors.delete(ANONYMOUS);
  currentVisitorId = ANONYMOUS;
  changeListener?.();
}

/** Stores the tags of one reply for the current visitor. True when something new was noted. */
export function recordFieldNotes(rawText: string, now = Date.now()): boolean {
  const { notes, quotes: said } = extractFieldNotes(rawText);
  if (notes.length === 0 && said.length === 0) return false;
  const record = recordFor(currentVisitorId, now);
  record.lastSeenAt = now;
  let changed = false;
  // The model tends to repeat its whole list ("dentist, hates jazz, from
  // Berlin"); keep single facts and merge overlaps instead of piling up.
  for (const fact of notes.flatMap((note) => note.split(/\s*[,;]\s*/)).map((fact) => fact.trim()).filter(Boolean)) {
    const lower = fact.toLowerCase();
    if (record.notes.some((existing) => existing.toLowerCase().includes(lower))) continue;
    const narrower = record.notes.findIndex((existing) => lower.includes(existing.toLowerCase()));
    if (narrower !== -1) record.notes.splice(narrower, 1);
    record.notes.push(fact);
    changed = true;
  }
  if (record.notes.length > MAX_NOTES_PER_VISITOR) record.notes.splice(0, record.notes.length - MAX_NOTES_PER_VISITOR);
  for (const text of said) {
    if (quotes.some((quote) => quote.text === text)) continue;
    quotes.push({ visitorId: currentVisitorId, text, at: now });
    changed = true;
  }
  if (quotes.length > MAX_QUOTES) quotes.splice(0, quotes.length - MAX_QUOTES);
  if (changed) changeListener?.();
  return changed;
}

/** What goes into the prompt's MEMORY_CONTEXT slot for the current visitor. */
export function memoryContext(now = Date.now()): string {
  prune(now);
  const record = visitors.get(currentVisitorId);
  if (!record || (record.notes.length === 0 && record.names.length === 0)) return '';
  const lines = ['# YOUR FIELD NOTES ON THE PERSON IN FRONT OF YOU'];
  if (record.returning) lines.push('You met them earlier tonight. Act like it.');
  if (record.names.length > 0) lines.push(`Name: ${record.names.join(', ')}.`);
  for (const note of record.notes) lines.push(`- ${note}`);
  lines.push('Use these when it is funny or sharp; never read them out as a list.');
  return lines.join('\n');
}

/** A recent quote from someone other than the current visitor, for gossip. */
export function pickGossip(random: () => number = Math.random, now = Date.now()): string | null {
  prune(now);
  // Without camera ids every quote is "anonymous" and may be this person's own.
  const others = quotes.filter((quote) => quote.visitorId !== currentVisitorId);
  if (others.length === 0) return null;
  return others[Math.floor(random() * others.length)]!.text;
}

/** For the operator panel. */
export function fieldNotesSnapshot(now = Date.now()): { visitorId: string | null; returning: boolean; names: string[]; notes: string[]; quotes: string[] } {
  prune(now);
  const record = visitors.get(currentVisitorId);
  return {
    visitorId: currentVisitorId || null,
    returning: record?.returning ?? false,
    names: record?.names ?? [],
    notes: record?.notes ?? [],
    quotes: quotes.slice(-8).map((quote) => quote.text).reverse(),
  };
}

/** Test helper. */
export function resetFieldNotes(): void {
  visitors.clear();
  quotes.length = 0;
  currentVisitorId = ANONYMOUS;
}

/**
 * Streams arrive token by token; a tag can be cut in half by the sentence
 * splitter and then spoken ("NOTE works in marketing"). This holds text back
 * from an opening [[ until its ]] arrives, drops note/quote tags and passes
 * other markers through.
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
        const tag = held.slice(open, close + 2);
        out += stripFieldNoteTags(tag) === '' ? '' : tag;
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
