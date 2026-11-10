// What Tubs knows about whom tonight: one card per person with their photos,
// notes, quotes and relationship (GET /memory). The same view is the
// dashboard's Memory tab and the page /?view=memory. Every change waits for a
// second click on the card itself, with a line saying exactly what it does
// (no browser dialogs: they are blocked in the sentient panel's iframe).
//
// The face library is curated here, photo by photo: each sample carries the
// audit's flag (it looks like someone else, or unlike its owner's other
// samples), and can be removed or moved to the person it belongs to, alone or
// several at once. The last change can be undone for a minute; earlier states
// come back from the library's backups ("Restore from backup").

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { MemoryCard, MemoryLibraryChangeResponse, MemoryLibraryEntry, MemoryResponse } from '../../../shared/contracts/memory.js';
import type { AppStore } from '../../state/app-state.js';
import { fetchJson, postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { clearText, flagText, forgetText, movePhotosText, removePersonText, removePhotosText, restoreText, shortTime, type BackupRestores } from './memory-text.js';
import '../../styles/memory-curation.css';

export const MEMORY_REFRESH_MS = 3000;
const PHOTOS_SHOWN = 6;
const POSITION_WORDS = { left: 'on the left', center: 'in the middle', right: 'on the right' } as const;

type Pending = { key: string; action: 'forget' | 'remove' } | { key: '*'; action: 'clear' } | null;
interface Undo { token: string; summary: string; until: number }
interface Backup { id: string; at: number; samples: number; people: Array<{ name: string; samples: number }>; restores: BackupRestores | null }

/** The dock tab: refreshes only while it is on screen. */
export function MemoryPanel({ store }: { store: AppStore }): JSX.Element {
  const active = useAppSelector(store, (current) => current.dockTab === 'memory' && !current.dockFolded && !current.uiHidden);
  return <MemoryView active={active} layout="dock" />;
}

export function MemoryView({ active, layout }: { active: boolean; layout: 'dock' | 'page' }): JSX.Element {
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [now, setNow] = useState(Date.now());
  const [restored, setRestored] = useState('');

  const load = useCallback(async () => {
    try {
      setMemory(await fetchJson<MemoryResponse>('/memory'));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void load();
    const timer = window.setInterval(() => void load(), MEMORY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  // The undo bar counts down, and goes when its minute is over.
  useEffect(() => {
    if (!undo) return undefined;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() > undo.until) setUndo(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [undo]);

  /** A library change: run it, offer its undo, reload. */
  const change = useCallback(async (route: string, body: unknown): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await postJson<unknown, MemoryLibraryChangeResponse>(route, body);
      setUndo({ token: result.undo, summary: result.summary, until: result.until });
      setNow(Date.now());
      await load();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }, [load]);

  async function confirm(): Promise<void> {
    if (!pending || busy) return;
    if (pending.action === 'remove') {
      const card = memory?.cards.find((each) => each.key === pending.key);
      if (card?.name && await change('/memory/library/remove', { name: card.name })) setPending(null);
      return;
    }
    setBusy(true);
    try {
      if (pending.action === 'clear') await postJson('/memory/clear', {});
      else await postJson('/memory/forget', { key: pending.key });
      setPending(null);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function takeBack(): Promise<void> {
    if (!undo) return;
    setBusy(true);
    try {
      await postJson('/memory/library/undo', { undo: undo.token });
      setUndo(null);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const counts = memory?.counts;
  const meta = counts ? `${counts.tonight} tonight · ${counts.inView} in view · ${counts.enrolled} in library` : '';
  const pendingClear = pending?.action === 'clear';

  return (
    <article className={`dock-section text-left memory-view memory-view-${layout}`} aria-label="Memory">
      <PanelHeader title="Memory" meta={meta} metaId="memory-counts" />
      <div className="panel-body panel-content flex flex-col gap-3 font-mono text-xs">
        {error && <p role="alert" className="text-rose-300">{error}</p>}
        {undo && (
          <div className="memory-undo" role="status">
            <span>{undo.summary}</span>
            <button type="button" className="button button-compact button-secondary" disabled={busy} onClick={() => void takeBack()}>Undo ({Math.max(0, Math.ceil((undo.until - now) / 1000))} s)</button>
          </div>
        )}
        {!memory && !error && <p className="text-slate-500">Loading…</p>}
        {memory && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {pendingClear ? (
                <ConfirmRow
                  question={clearText(memory.counts.tonight)}
                  yes="Clear tonight's notes"
                  busy={busy}
                  onYes={() => void confirm()}
                  onNo={() => setPending(null)}
                />
              ) : (
                <button type="button" className="button button-compact button-secondary" onClick={() => setPending({ key: '*', action: 'clear' })}>Clear tonight's notes</button>
              )}
              {!memory.relationshipsEnabled && <span className="text-slate-500">Relationships are off</span>}
            </div>
            {memory.library.length > 0 && (
              <p id="memory-library" className="text-slate-400">
                Face library: {memory.library.map((entry) => `${entry.name} ${entry.samples}`).join(' · ')}
              </p>
            )}
            <RestorePanel busy={busy} note={restored} onRestored={async (summary) => { setUndo(null); setError(''); setRestored(summary); await load(); }} onError={setError} />
            {memory.unattributedNotes.length > 0 && (
              <p className="text-slate-400">Camera off, about whoever talked: <span className="text-slate-300">{memory.unattributedNotes.join('; ')}</span></p>
            )}
            {memory.groupNotes.length > 0 && (
              <p className="text-slate-400">About a group: <span className="text-slate-300">{memory.groupNotes.join('; ')}</span></p>
            )}
            {memory.cards.length === 0 && <p className="text-slate-500">Nobody yet tonight, and the face library is empty.</p>}
            <div className="memory-cards">
              {memory.cards.map((card) => (
                <PersonCard
                  key={card.key}
                  card={card}
                  people={memory.library}
                  pending={pending && pending.key === card.key ? pending.action : null}
                  busy={busy}
                  onAsk={(action) => setPending({ key: card.key, action })}
                  onYes={() => void confirm()}
                  onNo={() => setPending(null)}
                  onChange={change}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

/** The library's backups (one before every change), each restorable with a line saying what comes back; the library it replaces is backed up too. */
function RestorePanel({ busy, note, onRestored, onError }: { busy: boolean; note: string; onRestored(summary: string): Promise<void>; onError(message: string): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [asking, setAsking] = useState<Backup | null>(null);

  async function list(): Promise<void> {
    try {
      setBackups((await fetchJson<{ backups: Backup[] }>('/memory/library/backups')).backups);
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function restore(backup: Backup): Promise<void> {
    try {
      await postJson('/memory/library/restore', { backup: backup.id });
      setAsking(null);
      await onRestored(`Restored the face library as it was at ${shortTime(backup.at)}.`);
      await list();
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <div className="memory-restore">
      <button type="button" className="button button-compact button-secondary" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void list(); }}>
        {open ? 'Hide backups' : 'Restore from backup'}
      </button>
      {note && <span className="text-emerald-300" role="status">{note}</span>}
      {open && (
        <ul className="memory-backups" aria-label="Face library backups">
          {backups === null && <li className="text-slate-500">Loading…</li>}
          {backups?.length === 0 && <li className="text-slate-500">No backups yet: one is taken before every change to the library.</li>}
          {backups?.map((backup) => (
            <li key={backup.id} className="memory-backup">
              <span className="text-slate-200">{shortTime(backup.at)}</span>
              <span className="text-slate-400">{backup.samples} samples · {backup.people.map((person) => `${person.name} ${person.samples}`).join(', ') || 'empty'}</span>
              {asking?.id === backup.id && backup.restores ? (
                <ConfirmRow question={restoreText(backup.at, backup.restores)} yes="Restore" busy={busy} onYes={() => void restore(backup)} onNo={() => setAsking(null)} />
              ) : (
                <button type="button" className="button button-compact button-secondary" onClick={() => setAsking(backup)}>Restore…</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type PhotoAction = { action: 'remove' | 'move'; ids: string[] } | null;

function PersonCard({ card, people, pending, busy, onAsk, onYes, onNo, onChange }: {
  card: MemoryCard;
  people: MemoryResponse['library'];
  pending: 'forget' | 'remove' | 'clear' | null;
  busy: boolean;
  onAsk(action: 'forget' | 'remove'): void;
  onYes(): void;
  onNo(): void;
  onChange(route: string, body: unknown): Promise<boolean>;
}): JSX.Element {
  const title = card.name ?? 'Unknown visitor';
  const flagged = card.library.filter((entry) => entry.flag);
  const [curating, setCurating] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [asking, setAsking] = useState<PhotoAction>(null);
  const others = people.filter((person) => person.name !== card.name);
  const [moveTo, setMoveTo] = useState('');

  // Selected photos that went (removed elsewhere, moved) drop out of the selection.
  const present = new Set(card.library.map((entry) => entry.id));
  const chosen = selected.filter((id) => present.has(id));

  // Library photos first, the flagged ones before the rest, then tonight's snapshot.
  const libraryPhotos = [...card.library].filter((entry) => entry.photo).sort((a, b) => Number(Boolean(b.flag)) - Number(Boolean(a.flag)));
  const snapshots = card.photos.filter((photo) => photo.source === 'snapshot');
  const shownCount = libraryPhotos.length + snapshots.length;
  const extra = shownCount - PHOTOS_SHOWN;

  /** The person a photo most resembles, as the Move picker's first choice. */
  function suggestedFor(ids: readonly string[]): string {
    for (const id of ids) {
      const like = card.library.find((entry) => entry.id === id)?.flag?.like?.name;
      if (like && others.some((person) => person.name === like)) return like;
    }
    return others[0]?.name ?? '';
  }

  function ask(action: 'remove' | 'move', ids: string[]): void {
    setAsking({ action, ids });
    if (action === 'move') setMoveTo(suggestedFor(ids));
  }

  async function run(): Promise<void> {
    if (!asking) return;
    const ok = asking.action === 'remove'
      ? await onChange('/memory/library/samples/remove', { ids: asking.ids })
      : await onChange('/memory/library/samples/move', { ids: asking.ids, to: moveTo });
    if (ok) {
      setAsking(null);
      setSelected([]);
    }
  }

  const toSamples = people.find((person) => person.name === moveTo)?.samples ?? 0;

  return (
    <section className={`memory-card ${card.inView ? 'is-in-view' : ''}`} aria-label={title} data-key={card.key}>
      <div className="memory-photos">
        {shownCount === 0 && <div className="memory-photo memory-photo-empty" aria-label="No photo">?</div>}
        {libraryPhotos.slice(0, PHOTOS_SHOWN).map((entry) => (
          <span key={entry.id} className={`memory-photo-frame ${entry.flag ? 'is-flagged' : ''}`} title={entry.flag ? flagText(entry.flag, card.name).join(' · ') : undefined}>
            <img className="memory-photo" src={entry.photo!} alt={`${title}, face library #${entry.index}`} loading="lazy" />
            {entry.flag && <span className="memory-photo-flag" aria-hidden="true">!</span>}
          </span>
        ))}
        {snapshots.slice(0, Math.max(0, PHOTOS_SHOWN - libraryPhotos.length)).map((photo) => (
          <img key={photo.url} className="memory-photo" src={photo.url} alt={`${title}, tonight`} loading="lazy" />
        ))}
        {extra > 0 && <span className="memory-photo-more">+{extra}</span>}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="memory-name">{title}</h3>
        {card.names.length > 1 && <span className="text-slate-400">also {card.names.filter((name) => name !== card.name).join(', ')}</span>}
        {card.inView && <span className="memory-badge memory-badge-live">in view, {POSITION_WORDS[card.inView]}</span>}
        {card.enrolled && <span className="memory-badge">face library · {card.library.length} sample{card.library.length === 1 ? '' : 's'}</span>}
        {flagged.length > 0 && <span className="memory-badge memory-badge-flag">{flagged.length} photo{flagged.length === 1 ? '' : 's'} to check</span>}
        {card.returning && <span className="memory-badge">back again</span>}
      </div>
      <p className="text-slate-400">
        {card.seenTonight
          ? `First seen ${clock(card.firstSeenAt)} · last ${clock(card.lastSeenAt)} · ${card.turns} turn${card.turns === 1 ? '' : 's'}`
          : 'Not seen tonight'}
      </p>
      {card.attitude && <p className="memory-attitude"><span className="text-slate-500">Relationship:</span> {card.attitude}</p>}
      {card.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-slate-300">{card.notes.map((note) => <li key={note}>· {note}</li>)}</ul>
      )}
      {card.quotes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-slate-300 italic">{card.quotes.map((quote) => <li key={quote}>“{quote}”</li>)}</ul>
      )}
      {card.otherPhotos.length > 0 && (
        <div className="memory-photos" aria-label="Other photos">
          {card.otherPhotos.map((photo) => <img key={photo.url} className="memory-photo" src={photo.url} alt={`${title}, other photo`} loading="lazy" />)}
        </div>
      )}

      {curating && (
        <div className="memory-curate" aria-label={`${title}'s face library photos`}>
          <div className="memory-curate-bar">
            <label className="memory-curate-all">
              <input
                type="checkbox"
                checked={chosen.length > 0 && chosen.length === card.library.length}
                onChange={(event) => setSelected(event.currentTarget.checked ? card.library.map((entry) => entry.id) : [])}
              />
              {chosen.length > 0 ? `${chosen.length} selected` : 'Select all'}
            </label>
            <button type="button" className="button button-compact button-secondary" disabled={chosen.length === 0 || others.length === 0} onClick={() => ask('move', chosen)}>Move selected to…</button>
            <button type="button" className="button button-compact button-danger" disabled={chosen.length === 0} onClick={() => ask('remove', chosen)}>Remove selected</button>
          </div>
          {asking && (
            <div className="memory-confirm" role="group" aria-label="Confirm">
              {asking.action === 'move' && (
                <label className="memory-move-to">
                  Move to
                  <select value={moveTo} onChange={(event) => setMoveTo(event.currentTarget.value)}>
                    {others.map((person) => <option key={person.name} value={person.name}>{person.name} ({person.samples})</option>)}
                  </select>
                </label>
              )}
              <span>{asking.action === 'remove' ? removePhotosText(card, asking.ids) : movePhotosText(card, asking.ids, moveTo, toSamples)}</span>
              <button type="button" className={`button button-compact ${asking.action === 'remove' ? 'button-danger' : 'button-secondary'}`} disabled={busy || (asking.action === 'move' && !moveTo)} onClick={() => void run()}>
                {asking.action === 'remove' ? `Remove ${asking.ids.length} photo${asking.ids.length === 1 ? '' : 's'}` : `Move to ${moveTo}`}
              </button>
              <button type="button" className="button button-compact button-secondary" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
            </div>
          )}
          <ul className="memory-samples">
            {card.library.map((entry) => (
              <SampleTile
                key={entry.id}
                entry={entry}
                owner={card.name}
                selected={chosen.includes(entry.id)}
                canMove={others.length > 0}
                onSelect={(on) => setSelected(on ? [...chosen, entry.id] : chosen.filter((id) => id !== entry.id))}
                onRemove={() => ask('remove', [entry.id])}
                onMove={() => ask('move', [entry.id])}
              />
            ))}
          </ul>
        </div>
      )}

      {pending === 'forget' || pending === 'remove' ? (
        <ConfirmRow
          question={pending === 'forget' ? forgetText(card) : removePersonText(card)}
          yes={pending === 'forget' ? 'Forget' : 'Delete from library'}
          busy={busy}
          onYes={onYes}
          onNo={onNo}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {card.enrolled && (
            <button type="button" className="button button-compact button-secondary" aria-expanded={curating} onClick={() => { setCurating(!curating); setAsking(null); }}>
              {curating ? 'Done with photos' : flagged.length > 0 ? `Check photos (${flagged.length} flagged)` : 'Edit photos'}
            </button>
          )}
          {card.seenTonight && <button type="button" className="button button-compact button-secondary" onClick={() => onAsk('forget')}>Forget tonight</button>}
          {card.enrolled && <button type="button" className="button button-compact button-danger" onClick={() => onAsk('remove')}>Remove from face library</button>}
        </div>
      )}
    </section>
  );
}

function SampleTile({ entry, owner, selected, canMove, onSelect, onRemove, onMove }: {
  entry: MemoryLibraryEntry;
  owner: string | null;
  selected: boolean;
  canMove: boolean;
  onSelect(on: boolean): void;
  onRemove(): void;
  onMove(): void;
}): JSX.Element {
  const flags = entry.flag ? flagText(entry.flag, owner) : [];
  return (
    <li className={`memory-sample ${entry.flag ? 'is-flagged' : ''} ${selected ? 'is-selected' : ''}`} data-sample={entry.id}>
      <label className="memory-sample-pick">
        <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.currentTarget.checked)} aria-label={`Select ${owner ?? 'sample'} #${entry.index}`} />
        {entry.photo
          ? <img className="memory-sample-photo" src={entry.photo} alt={`${owner ?? 'Sample'} #${entry.index}`} loading="lazy" />
          : <span className="memory-sample-photo memory-photo-empty">?</span>}
      </label>
      <span className="memory-sample-when">#{entry.index} · {shortTime(entry.createdAt)}</span>
      {flags.map((text) => <span key={text} className="memory-sample-flag">{text}</span>)}
      <span className="memory-sample-actions">
        <button type="button" className="button button-compact button-secondary" disabled={!canMove} onClick={onMove} aria-label={`Move ${owner ?? 'sample'} #${entry.index} to…`}>Move…</button>
        <button type="button" className="button button-compact button-danger" onClick={onRemove} aria-label={`Remove ${owner ?? 'sample'} #${entry.index}`}>Remove</button>
      </span>
    </li>
  );
}

function ConfirmRow({ question, yes, busy, onYes, onNo }: { question: string; yes: string; busy: boolean; onYes(): void; onNo(): void }): JSX.Element {
  return (
    <div className="memory-confirm" role="group" aria-label="Confirm">
      <span>{question}</span>
      <button type="button" className="button button-compact button-danger" disabled={busy} onClick={onYes}>{yes}</button>
      <button type="button" className="button button-compact button-secondary" disabled={busy} onClick={onNo}>Cancel</button>
    </div>
  );
}

function clock(at: number | null): string {
  if (at === null) return '–';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
