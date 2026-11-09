// What the memory view's confirmations say: exactly what will happen, with the
// counts and the names, before anything is deleted or moved. "Remove from face
// library?" did not say how many photos, or that tonight's notes stay.

import type { MemoryCard, MemoryLibraryEntry, MemorySampleFlag } from '../../../shared/contracts/memory.js';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "11 Feb 21:46" in the operator's time zone. */
export function shortTime(at: number | null): string {
  if (at === null) return 'undated';
  const date = new Date(at);
  return `${date.getDate()} ${date.toLocaleString('en-GB', { month: 'short' })} ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** "(taken 11 Feb 21:46)" or "(taken 11 Feb 03:51 to 27 Feb 19:34)". */
export function takenWhen(samples: ReadonlyArray<Pick<MemoryLibraryEntry, 'createdAt'>>): string {
  const times = samples.map((sample) => sample.createdAt).filter((at): at is number => at !== null).sort((a, b) => a - b);
  if (times.length === 0) return '(undated)';
  const first = shortTime(times[0]!);
  const last = shortTime(times.at(-1)!);
  return first === last ? `(taken ${first})` : `(taken ${first} to ${last})`;
}

const UNDO_NOTE = 'It cannot be undone after a minute (a backup is kept).';

export function forgetText(card: Pick<MemoryCard, 'name' | 'notes' | 'quotes' | 'turns' | 'enrolled' | 'library'>): string {
  const who = card.name ?? 'this visitor';
  const kept = card.enrolled ? `${card.name}'s ${plural(card.library.length, 'face sample')} stay` : 'no face samples are touched';
  return `Forget tonight: deletes the ${plural(card.notes.length, 'note')} and ${plural(card.quotes.length, 'quote')} Tubs kept about ${who} tonight, and that ${who} was here (${plural(card.turns, 'turn')}); the conversation itself and ${kept}.`;
}

export function removePersonText(card: Pick<MemoryCard, 'name' | 'library'>): string {
  const name = card.name ?? 'this person';
  return `Remove from face library: deletes all ${plural(card.library.length, 'face sample')} of ${name} permanently; Tubs stops recognising ${name}. Tonight's notes stay. ${UNDO_NOTE}`;
}

export function removePhotosText(card: Pick<MemoryCard, 'name' | 'library'>, ids: readonly string[]): string {
  const name = card.name ?? 'this person';
  const chosen = card.library.filter((entry) => ids.includes(entry.id));
  const rest = card.library.length - chosen.length;
  const after = rest > 0 ? `${name}'s other ${plural(rest, 'sample')} stay` : `that is all of ${name}'s samples: Tubs stops recognising ${name}`;
  return `Remove ${plural(chosen.length, 'photo')} of ${name} ${takenWhen(chosen)}: deleted from the face library; ${after}. ${UNDO_NOTE}`;
}

export function movePhotosText(card: Pick<MemoryCard, 'name' | 'library'>, ids: readonly string[], to: string, toSamples: number): string {
  const name = card.name ?? 'this person';
  const chosen = card.library.filter((entry) => ids.includes(entry.id));
  const rest = card.library.length - chosen.length;
  const after = rest > 0 ? `${name} keeps ${plural(rest, 'sample')}` : `${name} keeps none: Tubs stops recognising ${name}`;
  return `Move ${plural(chosen.length, 'photo')} from ${name} to ${to} ${takenWhen(chosen)}: Tubs matches ${chosen.length === 1 ? 'it' : 'them'} as ${to} from now on (${to} then has ${toSamples + chosen.length}); ${after}. Undo for a minute.`;
}

export function clearText(people: number): string {
  return `Clear tonight: deletes every note and quote Tubs kept tonight, about all ${plural(people, 'person', 'people')}; the conversation and the face library stay.`;
}

export interface BackupRestores {
  back: Array<{ name: string; samples: number }>;
  gone: Array<{ name: string; samples: number }>;
  changed: Array<{ name: string; from: number; to: number }>;
  unchanged: string[];
}

export function restoreText(at: number, restores: BackupRestores): string {
  const parts = [
    restores.back.length ? `brings back ${restores.back.map((person) => `${person.name} (${person.samples})`).join(', ')}` : '',
    restores.changed.length ? restores.changed.map((person) => `${person.name} ${person.from} → ${person.to}`).join(', ') : '',
    restores.gone.length ? `removes ${restores.gone.map((person) => `${person.name} (${person.samples})`).join(', ')}` : '',
    restores.unchanged.length ? `${restores.unchanged.join(', ')} unchanged` : '',
  ].filter(Boolean);
  return `Restore the face library as it was at ${shortTime(at)}: ${parts.join('; ') || 'nothing changes'}. The library now is kept as a backup first.`;
}

/** The badge on a photo: what the audit says, in a few words. */
export function flagText(flag: MemorySampleFlag, owner: string | null): string[] {
  return [
    flag.looksLike ? `looks like ${flag.looksLike.name} · ${Math.round(flag.looksLike.sim * 100)}%` : '',
    flag.unlikeOwn ? (owner ? `unlike ${owner}'s others` : 'unlike their others') : '',
  ].filter(Boolean);
}
