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

/**
 * The lines of the guided tour: gather (call the visitors over at the first stop), present (tell
 * about the picture just pulled up), floor (open the floor for questions about it), move (lead on to
 * the next stop, following the guide's flag). A request without a kind is a present from an older
 * director, which also led on to the next stop in the same line.
 */
export const SAY_KINDS = ['gather', 'present', 'floor', 'move'] as const;
export type SayKind = (typeof SAY_KINDS)[number];

/**
 * Which show the lines are for: the gallery tour (the default), or the screening (sentient-studio's
 * screening scene: a film plays on every screen at once and the heads host it shot by shot, like a
 * director's commentary). The screening's piece is the shot up on every screen; stop and of count
 * the shots; where is the window the heads host it at.
 */
export const SHOWS = ['tour', 'screening'] as const;
export type PresentShow = (typeof SHOWS)[number];

export interface PresentRequest {
  kind?: SayKind;
  /** absent: the tour */
  show?: PresentShow;
  /** the screening: the film's title and a line about it */
  film?: { title: string; about?: string };
  /** the screening: who the heads are tonight (the theme's words, e.g. what each wears) */
  cast?: string;
  /** the window the heads stand at, by its name (the Big Wall) */
  where: string;
  /** which stop of how many */
  stop: number;
  of: number;
  /** the tour's first stop: Tubs opens the tour */
  first: boolean;
  /** where the tour goes next, by name */
  next: string | null;
  /** the picture: needed to present it or open the floor on it */
  piece?: PresentPiece;
}

const MAX_TEXT = 400, MAX_SHORT = 120, MAX_FACTS = 8, MAX_TAGS = 8;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A present request from a body, or why it is not one. Strings are clipped; unknown fields dropped. */
export function parsePresent(body: unknown): PresentRequest | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.kind !== undefined && !(SAY_KINDS as readonly unknown[]).includes(b.kind)) return `present: kind must be one of ${SAY_KINDS.join(', ')}`;
  if (b.show !== undefined && !(SHOWS as readonly unknown[]).includes(b.show)) return `present: show must be one of ${SHOWS.join(', ')}`;
  const kind = b.kind as SayKind | undefined;
  const f = (b.film && typeof b.film === 'object' ? b.film : null) as Record<string, unknown> | null;
  const filmTitle = f ? str(f.title, MAX_SHORT) : undefined;
  if (b.show === 'screening' && !filmTitle) return 'a screening needs film.title';
  const filmAbout = f ? str(f.about, MAX_TEXT) : undefined;
  const cast = str(b.cast, MAX_TEXT);
  const screening = b.show === 'screening' ? { show: 'screening' as const, film: { title: filmTitle!, ...(filmAbout ? { about: filmAbout } : {}) }, ...(cast ? { cast } : {}) } : {};
  const where = str(b.where, MAX_SHORT);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1000 ? v : d);
  const base = { ...(kind ? { kind } : {}), ...screening, where: where ?? '', stop: num(b.stop, 1), of: num(b.of, 1), first: b.first === true, next: str(b.next, MAX_SHORT) ?? null };
  const p = (b.piece && typeof b.piece === 'object' ? b.piece : null) as Record<string, unknown> | null;
  const title = p ? str(p.title, MAX_SHORT) : undefined;
  if (!title && (kind === undefined || kind === 'present' || kind === 'floor')) return 'present needs piece.title';
  if (!where) return 'present needs where';
  if (!title) return base;
  const facts = Array.isArray(p!.facts)
    ? (p!.facts as unknown[])
      .filter((f): f is [string, string] => Array.isArray(f) && typeof f[0] === 'string' && typeof f[1] === 'string')
      .slice(0, MAX_FACTS)
      .map(([k, v]) => [k.slice(0, 40), v.slice(0, 200)] as [string, string])
    : [];
  const tags = Array.isArray(p!.tags) ? (p!.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, MAX_TAGS).map((t) => t.slice(0, 40)) : [];
  const piece: PresentPiece = { title };
  const date = str(p!.date, MAX_SHORT), by = str(p!.by, MAX_SHORT), text = str(p!.text, MAX_TEXT);
  if (date) piece.date = date;
  if (by) piece.by = by;
  if (text) piece.text = text;
  if (facts.length) piece.facts = facts;
  if (tags.length) piece.tags = tags;
  return { ...base, piece };
}

const TOUR = '[Gallery tour; no visitor said this]';

const SCREENING = '[Screening; no visitor said this]';

/** The screening's lines: open it, comment on the shot up on every screen, open the floor, call the next shot. */
function screeningContext(r: PresentRequest): string {
  const film = r.film ?? { title: 'the film' };
  const about = `Tonight every screen in the studio plays the film "${film.title}", shot by shot.${film.about ? ` ${film.about}` : ''}${r.cast ? ` ${r.cast}` : ''}`;
  if (r.kind === 'gather') {
    return `${SCREENING} ${about} You two host it like a director's commentary, here at the ${r.where}. Open the screening in one or two short sentences, your way: welcome the visitors and tell them to watch the screens, the film waits for you. Do not describe a shot yet.`;
  }
  if (r.kind === 'move') return `${SCREENING} ${about} Call for the next shot in a few words, like a director on set. Small may add a quick quip.`;
  const p = r.piece ?? { title: 'this shot' };
  if (r.kind === 'floor') {
    return `${SCREENING} The shot "${p.title}" is on every screen. Ask the visitors, in one short line, whether they have a question or a thought about it before the next shot. If someone answers, reply to them as usual. Do not describe the shot again.`;
  }
  const lines = [
    `${SCREENING} ${about}`,
    `On every screen now, shot ${r.stop} of ${r.of}: "${p.title}"${p.date ? `, ${p.date} into the film` : ''}.`,
  ];
  if (p.text) lines.push(`What it shows: ${p.text}`);
  lines.push(
    `Comment on it like a director's commentary, here at the ${r.where}, in two to four short sentences between you: what we are looking at and one thing to notice, with a joke if one comes. Say only what the shot shows and what you were told; never invent the plot, names or facts about real people.`,
  );
  if (r.first) lines.push('This is the first shot you comment on: one or two words to start.');
  return lines.join('\n');
}

/** What the turn is told: where they are, the picture if any, and which line of the tour to say. */
export function presentContext(r: PresentRequest): string {
  if (r.show === 'screening') return screeningContext(r);
  // Seen live: the lines came, but the heads did not lead: nobody knew what the tour was or what to do,
  // and between the lines they went back to roasting. Each line now says where they are, what to do and
  // where they go next.
  if (r.kind === 'gather') {
    return `${TOUR} You two are starting a guided tour: a walk through Alan Watts's life in pictures from his archive, hung through the studio's windows, ${r.of} stops${r.next ? `, starting here at the ${r.where} and then on to the ${r.next}` : ''}. Tubs holds up his little tour-guide flag. Tubs: open the tour like a city tour guide, your way, in two or three short sentences: welcome them, say what the tour is, and tell them to gather round here and stay close to the flag. Small may add one line. Do not describe a picture yet.`;
  }
  if (r.kind === 'move') {
    return r.next
      ? `${TOUR} You are done at the ${r.where} (stop ${r.stop} of ${r.of}). Tubs raises his tour-guide flag and leads: tell everyone to follow it to the ${r.next}, the next stop, and give them a reason to come (the next chapter of Watts's life waits there), in one or two short lines. Small may add a quick quip.`
      : `${TOUR} That was the last stop of the tour. Tubs thanks the visitors in one short line.`;
  }
  const p = r.piece ?? { title: 'the picture' };
  if (r.kind === 'floor') {
    return `${TOUR} You have just told the visitors about "${p.title}" at the ${r.where}. Open the floor: ask whether anyone has a question or a thought about it, in one short line. If someone answers, reply to them as usual. Do not tell about the picture again.`;
  }
  const lines = [
    `[Gallery tour; no visitor said this] You two are guiding the visitors through a gallery of pictures from the Alan Watts archive, hung in a row through the studio. You are at the ${r.where} (stop ${r.stop} of ${r.of}) and are showing everyone this picture:`,
    `"${p.title}"${p.date ? `, ${p.date}` : ''}${p.by ? `, from the series "${p.by}"` : ''}.`,
  ];
  if (p.text) lines.push(`What it shows: ${p.text}`);
  if (p.facts?.length) lines.push(`What the archive knows: ${p.facts.map(([k, v]) => `${k}: ${v}`).join('; ')}.`);
  if (p.tags?.length) lines.push(`Tags: ${p.tags.join(', ')}.`);
  lines.push(
    'Tubs: present it to the visitors in two to four short sentences, your way: what we are looking at, one thing worth knowing, and if it fits a thought of Watts\'s in your own words. Say only what the archive supports; never invent dates, places or names, and do not read the facts out like a list. Small may add one short line about the picture itself.',
  );
  // an older director (no kind) said the whole stop in this one line
  if (!r.kind && r.first) lines.push('This is the first stop: open the tour in a few words before the picture.');
  if (!r.kind && r.next) lines.push(`End by inviting everyone on to the ${r.next}.`);
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
