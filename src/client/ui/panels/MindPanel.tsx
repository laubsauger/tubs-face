import { useCallback, useEffect, useState, type JSX } from 'react';
import type { BitStatus, BitsResponse } from '../../../shared/contracts/bits.js';
import type { AppStore } from '../../state/app-state.js';
import { moodExpression } from '../../behavior/emotion-runtime.js';
import { fetchJson, postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import { formatAwakeElapsed } from '../utils/formatters.js';
import { PanelHeader } from './PanelHeader.js';

const POSITION_LABELS = { left: 'Left', center: 'Middle', right: 'Right' } as const;

// The idle face the mood leads to, said as a word an operator understands.
const MOOD_WORDS: Record<string, string> = {
  angry: 'irritated',
  sad: 'sulking',
  happy: 'delighted',
  smug: 'smug',
  smile: 'pleased',
};

/** Tubs's mood in one word; the status bar shows it too. */
export function moodWordFor(mood: { sleeping: boolean; pos: number; neg: number; arousal: number }): string {
  if (mood.sleeping) return 'asleep';
  return MOOD_WORDS[moodExpression({ pos: mood.pos, neg: mood.neg, arousal: mood.arousal }) ?? ''] ?? 'neutral';
}

/** What Tubs is feeling and doing right now, for the operator. */
export function MindPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    expression: current.currentExpression,
    sleeping: current.sleeping,
    conversationActive: current.conversationActive,
    awakeElapsedSec: current.awakeElapsedSec,
    // Rounded so the panel re-renders when the bars visibly move, not every frame.
    pos: Math.round(current.moodPos * 50) / 50,
    neg: Math.round(current.moodNeg * 50) / 50,
    arousal: Math.round(current.moodArousal * 50) / 50,
    fieldNotes: current.fieldNotes,
    active: current.dockTab === 'mind' && !current.dockFolded && !current.uiHidden,
  }));
  const notes = state.fieldNotes;
  const moodWord = moodWordFor(state);

  return (
    <article className="dock-section text-left">
      <PanelHeader title="Mind" meta={moodWord} />
      <div className="panel-body panel-content flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3 bg-slate-950/50 p-3 rounded-xl border border-slate-800 font-mono text-xs">
          <span className="text-slate-400">Feels <span id="mind-mood" className="font-bold text-cyan-300">{moodWord}</span></span>
          <span className="text-slate-400">Face <span id="mind-expression" className="font-bold text-slate-200">{state.expression}</span></span>
        </div>
        <div className="flex flex-col gap-2 font-mono text-[11px]">
          <MoodBar label="Pleased" value={state.pos} colorClass="bg-emerald-400" />
          <MoodBar label="Annoyed" value={state.neg} colorClass="bg-rose-400" />
          <MoodBar label="Energy" value={state.arousal} colorClass="bg-amber-300" />
        </div>
        <dl className="grid grid-cols-[90px_1fr] gap-x-2 gap-y-2 text-xs font-mono">
          <dt className="text-slate-500">Talking</dt>
          <dd className="text-slate-300 font-bold">{state.conversationActive ? 'in a conversation' : 'nobody'}</dd>
          <dt className="text-slate-500">Awake</dt>
          <dd className="text-slate-300 font-bold">{state.sleeping ? 'asleep' : formatAwakeElapsed(state.awakeElapsedSec)}</dd>
        </dl>
        <section id="mind-notes" className="flex flex-col gap-1 font-mono text-xs" aria-label="Field notes">
          <div className="text-slate-500 uppercase tracking-wider text-[10px]">Field notes</div>
          {notes.people.length === 0 && <p className="text-slate-500">Nobody in view.</p>}
          {notes.people.map((person) => (
            <div key={person.id} className="flex flex-col gap-0.5">
              <div className="text-slate-400">
                {notes.people.length > 1 ? `${POSITION_LABELS[person.position]} · ` : ''}
                {person.names.length > 0 ? person.names.join(', ') : 'stranger'}
                {person.returning ? ' · back again' : ''}
              </div>
              {person.notes.length === 0
                ? <p className="text-slate-500 pl-2">nothing yet</p>
                : <ul className="flex flex-col gap-0.5 text-slate-300 pl-2">{person.notes.map((note) => <li key={note}>· {note}</li>)}</ul>}
            </div>
          ))}
          {notes.groupNotes.length > 0 && (
            <div className="text-slate-400">The group: <span className="text-slate-300">{notes.groupNotes.join('; ')}</span></div>
          )}
          {notes.quotes.length > 0 && (
            <>
              <div className="text-slate-500 uppercase tracking-wider text-[10px] mt-1">Overheard tonight</div>
              <ul id="mind-quotes" className="flex flex-col gap-0.5 text-slate-400 italic">{notes.quotes.slice(0, 4).map((quote) => <li key={quote}>"{quote}"</li>)}</ul>
            </>
          )}
        </section>
        <RunningBits active={state.active} />
      </div>
    </article>
  );
}

export const BITS_REFRESH_MS = 5000;

function minutesWords(ms: number): string {
  return ms < 60_000 ? 'under a minute' : `${Math.round(ms / 60_000)} min`;
}

/** One running bit in words: uses tonight, when last, and when it may be offered again. */
export function bitStateWords(bit: BitStatus, now: number): string {
  const parts = [bit.uses === 0 ? 'not used yet' : `${bit.uses}× tonight`];
  if (bit.lastUsedAt !== null) parts.push(`last ${minutesWords(Math.max(0, now - bit.lastUsedAt))} ago`);
  if (!bit.enabled) parts.push('off');
  else parts.push(bit.cooldownLeftMs > 0 ? `cooldown ${minutesWords(bit.cooldownLeftMs)}` : 'ready');
  return parts.join(' · ');
}

/** What the next stage direction tells the heads to stay off. */
export function stayOffWords(stayOff: BitsResponse['stayOff']): string {
  const quoted = (terms: string[]) => terms.map((term) => `"${term}"`).join(', ');
  const parts = [
    ...(stayOff.all.length > 0 ? [quoted(stayOff.all)] : []),
    ...(stayOff.main.length > 0 ? [`Tubs: ${quoted(stayOff.main)}`] : []),
    ...(stayOff.small.length > 0 ? [`Small: ${quoted(stayOff.small)}`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : 'nothing';
}

/**
 * The running bits (GET /bits): how often each came up tonight, its cooldown
 * and an on/off for the night, plus what the heads are told to stay off.
 */
function RunningBits({ active }: { active: boolean }): JSX.Element {
  const [bits, setBits] = useState<BitsResponse | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setBits(await fetchJson<BitsResponse>('/bits'));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void load();
    const timer = window.setInterval(() => void load(), BITS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  async function toggle(id: string, enabled: boolean): Promise<void> {
    try {
      setBits(await postJson<{ id: string; enabled: boolean }, BitsResponse>('/bits', { id, enabled }));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <section id="mind-bits" className="flex flex-col gap-1 font-mono text-xs" aria-label="Running bits">
      <div className="text-slate-500 uppercase tracking-wider text-[10px]">Running bits</div>
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      {!bits && !error && <p className="text-slate-500">Loading…</p>}
      {bits && bits.bits.length === 0 && <p className="text-slate-500">None in this preset.</p>}
      {bits?.bits.map((bit) => {
        const label = bit.id.replace(/[-_]+/g, ' ');
        return (
          <label key={bit.id} className="grid grid-cols-[1fr_auto] items-center gap-2" title={bit.text}>
            <span className="flex flex-col min-w-0">
              <span className={bit.enabled ? 'text-slate-300' : 'text-slate-500 line-through'}>
                {label}
                {bit.head !== 'both' && <span className="text-slate-500">{` · ${bit.head === 'small' ? 'Small' : 'Tubs'}`}</span>}
                {bit.stayOff && <span className="text-amber-300"> · stay off</span>}
              </span>
              <span className="text-slate-500 text-[11px]">{bitStateWords(bit, bits.now)}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="control-switch"
              aria-label={`Offer ${label}`}
              checked={bit.enabled}
              onChange={(event) => void toggle(bit.id, event.currentTarget.checked)}
            />
          </label>
        );
      })}
      {bits && (
        <>
          <div className="text-slate-500 uppercase tracking-wider text-[10px] mt-1">Stay off</div>
          <p id="mind-stay-off" className="text-slate-400">{stayOffWords(bits.stayOff)}</p>
        </>
      )}
    </section>
  );
}

function MoodBar({ label, value, colorClass }: { label: string; value: number; colorClass: string }): JSX.Element {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="grid grid-cols-[64px_1fr_32px] items-center gap-2" title={`${label} ${percent}%`}>
      <span className="text-slate-500">{label}</span>
      <span className="h-2 rounded-full bg-slate-800 overflow-hidden" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className={`block h-full rounded-full ${colorClass} transition-[width] duration-300`} style={{ width: `${percent}%` }} />
      </span>
      <span className="text-right text-slate-400 tabular-nums">{percent}</span>
    </div>
  );
}
