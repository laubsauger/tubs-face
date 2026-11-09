// What Tubs knows about whom tonight: one card per person with their photos,
// notes, quotes and relationship (GET /memory). The same view is the
// dashboard's Memory tab and the page /?view=memory. Every change waits for a
// second click on the card itself (no browser dialogs: they are blocked in the
// sentient panel's iframe).

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { MemoryCard, MemoryResponse } from '../../../shared/contracts/memory.js';
import type { AppStore } from '../../state/app-state.js';
import { fetchJson, postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';

export const MEMORY_REFRESH_MS = 3000;
const PHOTOS_SHOWN = 6;
const POSITION_WORDS = { left: 'on the left', center: 'in the middle', right: 'on the right' } as const;

type Pending = { key: string; action: 'forget' | 'remove' } | { key: '*'; action: 'clear' } | null;

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

  async function confirm(): Promise<void> {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (pending.action === 'clear') await postJson('/memory/clear', {});
      else if (pending.action === 'forget') await postJson('/memory/forget', { key: pending.key });
      else {
        const card = memory?.cards.find((each) => each.key === pending.key);
        if (card?.name) await postJson('/memory/library/remove', { name: card.name });
      }
      setPending(null);
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
        {!memory && !error && <p className="text-slate-500">Loading…</p>}
        {memory && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {pendingClear ? (
                <ConfirmRow
                  question="Clear every note and quote from tonight?"
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
                  pending={pending && pending.key === card.key ? pending.action : null}
                  busy={busy}
                  onAsk={(action) => setPending({ key: card.key, action })}
                  onYes={() => void confirm()}
                  onNo={() => setPending(null)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function PersonCard({ card, pending, busy, onAsk, onYes, onNo }: {
  card: MemoryCard;
  pending: 'forget' | 'remove' | 'clear' | null;
  busy: boolean;
  onAsk(action: 'forget' | 'remove'): void;
  onYes(): void;
  onNo(): void;
}): JSX.Element {
  const title = card.name ?? 'Unknown visitor';
  const extra = card.photos.length - PHOTOS_SHOWN;
  return (
    <section className={`memory-card ${card.inView ? 'is-in-view' : ''}`} aria-label={title} data-key={card.key}>
      <div className="memory-photos">
        {card.photos.length === 0 && <div className="memory-photo memory-photo-empty" aria-label="No photo">?</div>}
        {card.photos.slice(0, PHOTOS_SHOWN).map((photo) => (
          <img key={photo.url} className="memory-photo" src={photo.url} alt={`${title}, ${photo.source === 'library' ? 'face library' : 'tonight'}`} loading="lazy" />
        ))}
        {extra > 0 && <span className="memory-photo-more">+{extra}</span>}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="memory-name">{title}</h3>
        {card.names.length > 1 && <span className="text-slate-400">also {card.names.filter((name) => name !== card.name).join(', ')}</span>}
        {card.inView && <span className="memory-badge memory-badge-live">in view, {POSITION_WORDS[card.inView]}</span>}
        {card.enrolled && <span className="memory-badge">face library · {card.library.length} sample{card.library.length === 1 ? '' : 's'}</span>}
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
      {pending === 'forget' || pending === 'remove' ? (
        <ConfirmRow
          question={pending === 'forget'
            ? `Forget what Tubs noted about ${card.name ?? 'this visitor'} tonight?`
            : `Delete ${card.name}'s ${card.library.length} face library sample${card.library.length === 1 ? '' : 's'} and photos? Tubs will no longer recognise them.`}
          yes={pending === 'forget' ? 'Forget' : 'Delete from library'}
          busy={busy}
          onYes={onYes}
          onNo={onNo}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {card.seenTonight && <button type="button" className="button button-compact button-secondary" onClick={() => onAsk('forget')}>Forget tonight</button>}
          {card.enrolled && <button type="button" className="button button-compact button-danger" onClick={() => onAsk('remove')}>Remove from face library</button>}
        </div>
      )}
    </section>
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
