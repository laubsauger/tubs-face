// The memory view (/?view=memory, the dashboard's Memory tab, GET /memory):
// what Tubs knows about whom tonight, one card per person with their photos.

export type MemoryPosition = 'left' | 'center' | 'right';

export interface MemoryPhoto {
  /** Same origin: /memory/photo/<face id> (a face library sample) or /memory/snapshot/<visitor id>. */
  url: string;
  source: 'library' | 'snapshot';
  at: number | null;
}

export interface MemoryLibraryEntry {
  id: string;
  createdAt: number | null;
  photo: string | null;
}

export interface MemoryCard {
  /** "name:<name>" for a known name, "visitor:<id>" for someone unnamed; what the actions take. */
  key: string;
  name: string | null;
  /** Every name heard or recognised for them tonight. */
  names: string[];
  /** In the face library, with its samples. */
  enrolled: boolean;
  library: MemoryLibraryEntry[];
  /** Their faces: library samples, else the snapshot taken when they were noted tonight. */
  photos: MemoryPhoto[];
  /** Room for photos from elsewhere (the photobooth, later); empty for now. */
  otherPhotos: MemoryPhoto[];
  seenTonight: boolean;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  returning: boolean;
  turns: number;
  notes: string[];
  quotes: string[];
  /** Their relationship attitude (config/relationships.json), if they have one. */
  attitude: string | null;
  /** Where they are while in view; null when not in view. */
  inView: MemoryPosition | null;
}

/** GET /memory */
export interface MemoryResponse {
  cards: MemoryCard[];
  /** Notes about a group that did not say who. */
  groupNotes: string[];
  /** Notes taken with the camera off, about whoever was talking. */
  unattributedNotes: string[];
  /** The face library: names and how many samples each has. */
  library: Array<{ name: string; samples: number }>;
  relationshipsEnabled: boolean;
  counts: { tonight: number; inView: number; enrolled: number };
}

/** POST /memory/forget: drop their notes, quotes and snapshot for tonight. */
export interface MemoryForgetRequest {
  key: string;
}

/** POST /memory/library/remove: delete all face library samples of this name (privacy). */
export interface MemoryLibraryRemoveRequest {
  name: string;
}
