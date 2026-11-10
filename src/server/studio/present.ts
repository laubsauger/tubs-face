// The gallery tour (sentient-studio contract §6, §8): the director has walked both heads to a
// window and pulled a picture of the Alan Watts archive up to the glass; Tubs tells the visitors
// about it. One ordinary proactive turn, so Small may chime in. It never cuts off a reply someone
// is waiting for: while a reply is being made or a head talks, the picture waits (a proactive line
// would be dropped then, and the stop stood silent), and it starts at the first quiet moment.
// Nothing reruns or rewrites the reply.

import type { PokeDeps } from './poke.js';

/** a picture waits this long for a quiet moment at most (ms), checking this often */
export const PRESENT_WAIT_MAX_MS = 60_000;
const PRESENT_POLL_MS = 250;

export interface PresentDeps extends PokeDeps {
  /** a reply is being made, or a head is talking or about to */
  busy(): boolean;
}

export interface PresentPiece {
  title: string;
  date?: string;
  by?: string;
  text?: string;
  facts?: [string, string][];
  tags?: string[];
}

export interface PresentRequest {
  /** the window the heads stand at, by its name (the Big Wall) */
  where: string;
  /** which stop of how many */
  stop: number;
  of: number;
  /** the tour's first stop: Tubs opens the tour */
  first: boolean;
  /** where the tour goes next, by name */
  next: string | null;
  piece: PresentPiece;
}

const MAX_TEXT = 400, MAX_SHORT = 120, MAX_FACTS = 8, MAX_TAGS = 8;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A present request from a body, or why it is not one. Strings are clipped; unknown fields dropped. */
export function parsePresent(body: unknown): PresentRequest | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const p = (b.piece && typeof b.piece === 'object' ? b.piece : null) as Record<string, unknown> | null;
  const title = p ? str(p.title, MAX_SHORT) : undefined;
  if (!title) return 'present needs piece.title';
  const where = str(b.where, MAX_SHORT);
  if (!where) return 'present needs where';
  const facts = Array.isArray(p!.facts)
    ? (p!.facts as unknown[])
      .filter((f): f is [string, string] => Array.isArray(f) && typeof f[0] === 'string' && typeof f[1] === 'string')
      .slice(0, MAX_FACTS)
      .map(([k, v]) => [k.slice(0, 40), v.slice(0, 200)] as [string, string])
    : [];
  const tags = Array.isArray(p!.tags) ? (p!.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, MAX_TAGS).map((t) => t.slice(0, 40)) : [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1000 ? v : d);
  const piece: PresentPiece = { title };
  const date = str(p!.date, MAX_SHORT), by = str(p!.by, MAX_SHORT), text = str(p!.text, MAX_TEXT);
  if (date) piece.date = date;
  if (by) piece.by = by;
  if (text) piece.text = text;
  if (facts.length) piece.facts = facts;
  if (tags.length) piece.tags = tags;
  return { where, stop: num(b.stop, 1), of: num(b.of, 1), first: b.first === true, next: str(b.next, MAX_SHORT) ?? null, piece };
}

/** What the turn is told: where they are, the picture, and how to tell about it. */
export function presentContext(r: PresentRequest): string {
  const p = r.piece;
  const lines = [
    `[Gallery tour; no visitor said this] You two are guiding the visitors through a gallery of pictures from the Alan Watts archive, hung in a row through the studio. You are at the ${r.where} (stop ${r.stop} of ${r.of}) and have just pulled this picture up for everyone to see:`,
    `"${p.title}"${p.date ? `, ${p.date}` : ''}${p.by ? `, from the series "${p.by}"` : ''}.`,
  ];
  if (p.text) lines.push(`What it shows: ${p.text}`);
  if (p.facts?.length) lines.push(`What the archive knows: ${p.facts.map(([k, v]) => `${k}: ${v}`).join('; ')}.`);
  if (p.tags?.length) lines.push(`Tags: ${p.tags.join(', ')}.`);
  lines.push(
    'Tubs: present it to the visitors in two to four short sentences, your way: what we are looking at, one thing worth knowing, and if it fits a thought of Watts\'s in your own words. Say only what the archive supports; never invent dates, places or names, and do not read the facts out like a list. Small may add one short line about the picture itself.',
  );
  if (r.first) lines.push('This is the first stop: open the tour in a few words before the picture.');
  if (r.next) lines.push(`End by inviting everyone on to the ${r.next}.`);
  return lines.join('\n');
}

let waiting: { timer: ReturnType<typeof setTimeout>; reject: (err: Error) => void } | null = null;

/**
 * Wake both heads and start the turn about the picture at the first quiet moment. Resolves once the
 * turn has started (the director then listens for its end); rejects when no quiet moment came in
 * PRESENT_WAIT_MAX_MS, or a newer picture replaced this one.
 */
export function present(r: PresentRequest, deps: PresentDeps): Promise<void> {
  deps.noteAwake();
  deps.broadcast({ type: 'wake' });
  if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error('a newer picture replaced it')); waiting = null; }
  const since = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (deps.busy()) {
        if (Date.now() - since > PRESENT_WAIT_MAX_MS) { waiting = null; reject(new Error('the heads were busy the whole time')); return; }
        waiting = { timer: setTimeout(check, PRESENT_POLL_MS), reject };
        return;
      }
      waiting = null;
      deps.startProactiveTurn(presentContext(r), deps.broadcast);
      resolve();
    };
    check();
  });
}
