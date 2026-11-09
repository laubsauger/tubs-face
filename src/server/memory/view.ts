// The memory view: tonight's field notes, the face library and the
// relationships, put together as one card per person. A name heard or
// recognised tonight joins that name's library samples on one card; someone
// unnamed gets a card of their own, with the snapshot taken when they were
// noted. Library people not seen tonight follow, so the overview shows
// everyone Tubs can recognise.

import type { EnrolledFace } from '../../shared/contracts/faces.js';
import type { MemoryCard, MemoryResponse } from '../../shared/contracts/memory.js';
import type { PersonMemory } from '../assistant/field-notes.js';
import type { Relationship } from '../assistant/relationships.js';
import type { SampleAudit } from '../faces/audit.js';

export interface MemorySources {
  /** The library audit by sample id (server/faces/audit.ts); none: no flags. */
  audit?: ReadonlyMap<string, SampleAudit>;
  people: PersonMemory[];
  groupNotes: string[];
  unattributedNotes: string[];
  faces: readonly EnrolledFace[];
  relationships: readonly Relationship[];
  relationshipsEnabled: boolean;
}

const keyOf = (name: string) => name.trim().toLowerCase();
export const photoUrl = (faceId: string) => `/memory/photo/${encodeURIComponent(faceId)}`;
export const snapshotUrl = (visitorId: string) => `/memory/snapshot/${encodeURIComponent(visitorId)}`;

export function buildMemory(sources: MemorySources): MemoryResponse {
  const libraryByName = new Map<string, EnrolledFace[]>();
  for (const face of sources.faces) {
    const key = keyOf(face.name);
    if (!key) continue;
    libraryByName.set(key, [...(libraryByName.get(key) ?? []), face]);
  }
  const attitudeOf = (name: string | null) => (name ? sources.relationships.find((entry) => keyOf(entry.name) === keyOf(name))?.attitude ?? null : null);

  const cards = new Map<string, MemoryCard>();
  for (const person of sources.people) {
    const name = person.names[0] ?? null;
    const key = name ? `name:${keyOf(name)}` : `visitor:${person.id}`;
    const card = cards.get(key) ?? emptyCard(key, name);
    for (const each of person.names) if (!card.names.some((known) => keyOf(known) === keyOf(each))) card.names.push(each);
    card.seenTonight = true;
    card.firstSeenAt = card.firstSeenAt === null ? person.firstSeenAt : Math.min(card.firstSeenAt, person.firstSeenAt);
    card.lastSeenAt = card.lastSeenAt === null ? person.lastSeenAt : Math.max(card.lastSeenAt, person.lastSeenAt);
    card.returning ||= person.returning;
    card.turns += person.turns;
    for (const note of person.notes) if (!card.notes.includes(note)) card.notes.push(note);
    for (const quote of person.quotes) if (!card.quotes.includes(quote)) card.quotes.push(quote);
    card.inView ??= person.position;
    if (person.thumbnail) card.photos.push({ url: snapshotUrl(person.id), source: 'snapshot', at: person.firstSeenAt });
    cards.set(key, card);
  }
  // Library people not seen tonight still get a card.
  for (const [key, faces] of libraryByName) {
    if (!cards.has(`name:${key}`)) cards.set(`name:${key}`, emptyCard(`name:${key}`, faces[0]!.name));
  }
  for (const card of cards.values()) {
    const faces = card.name ? libraryByName.get(keyOf(card.name)) ?? [] : [];
    card.enrolled = faces.length > 0;
    card.library = faces.map((face, position) => {
      const audit = sources.audit?.get(face.id);
      const flagged = audit && (audit.flags.looksLike || audit.flags.unlikeOwn);
      return {
        id: face.id,
        createdAt: face.createdAt ?? null,
        photo: face.thumbnail ? photoUrl(face.id) : null,
        index: audit?.index ?? position + 1,
        flag: flagged ? { looksLike: audit.flags.looksLike, unlikeOwn: audit.flags.unlikeOwn, like: audit.like } : null,
      };
    }).sort((a, b) => a.index - b.index);
    // Library samples first: they are the clear, front-on ones.
    card.photos = [
      ...faces.filter((face) => face.thumbnail).map((face) => ({ url: photoUrl(face.id), source: 'library' as const, at: face.createdAt ?? null })),
      ...card.photos,
    ];
    card.attitude = attitudeOf(card.name);
  }

  const ordered = [...cards.values()].sort((a, b) =>
    Number(b.inView !== null) - Number(a.inView !== null)
    || Number(b.seenTonight) - Number(a.seenTonight)
    || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
    || (a.name ?? '').localeCompare(b.name ?? ''));
  const library = [...libraryByName.values()].map((faces) => ({ name: faces[0]!.name, samples: faces.length })).sort((a, b) => b.samples - a.samples || a.name.localeCompare(b.name));
  return {
    cards: ordered,
    groupNotes: sources.groupNotes,
    unattributedNotes: sources.unattributedNotes,
    library,
    relationshipsEnabled: sources.relationshipsEnabled,
    counts: {
      tonight: ordered.filter((card) => card.seenTonight).length,
      inView: ordered.filter((card) => card.inView !== null).length,
      enrolled: library.length,
    },
  };
}

function emptyCard(key: string, name: string | null): MemoryCard {
  return {
    key,
    name,
    names: name ? [name] : [],
    enrolled: false,
    library: [],
    photos: [],
    otherPhotos: [],
    seenTonight: false,
    firstSeenAt: null,
    lastSeenAt: null,
    returning: false,
    turns: 0,
    notes: [],
    quotes: [],
    attitude: null,
    inView: null,
  };
}

/** Loopback, private (RFC 1918, unique local) and link-local addresses: the venue's own network. */
export function isLocalNetworkAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  const parts = v4.split('.').map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = address.toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}
