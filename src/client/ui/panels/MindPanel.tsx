import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { moodExpression } from '../../behavior/emotion-runtime.js';
import { useAppSelector } from '../react-store.js';
import { formatAwakeElapsed } from '../utils/formatters.js';
import { PanelHeader } from './PanelHeader.js';

// The idle face the mood leads to, said as a word an operator understands.
const MOOD_WORDS: Record<string, string> = {
  angry: 'irritated',
  sad: 'sulking',
  happy: 'delighted',
  smug: 'smug',
  smile: 'pleased',
};

/** What Tubs is feeling and doing right now, for the operator. */
export function MindPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.mind),
    expression: current.currentExpression,
    sleeping: current.sleeping,
    conversationActive: current.conversationActive,
    awakeElapsedSec: current.awakeElapsedSec,
    // Rounded so the panel re-renders when the bars visibly move, not every frame.
    pos: Math.round(current.moodPos * 50) / 50,
    neg: Math.round(current.moodNeg * 50) / 50,
    arousal: Math.round(current.moodArousal * 50) / 50,
    fieldNotes: current.fieldNotes,
  }));
  const notes = state.fieldNotes;
  const moodWord = state.sleeping
    ? 'asleep'
    : MOOD_WORDS[moodExpression({ pos: state.pos, neg: state.neg, arousal: state.arousal }) ?? ''] ?? 'neutral';

  return (
    <article className={`panel-surface panel-surface-compact transition-all text-left ${state.collapsed ? 'is-collapsed h-11' : ''}`}>
      <PanelHeader store={store} panelKey="mind" title="Mind" meta={moodWord} />
      <div className={`panel-body panel-content flex flex-col gap-3 ${state.collapsed ? 'hidden' : ''}`}>
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
        <section className="flex flex-col gap-1 font-mono text-xs" aria-label="Field notes">
          <div className="text-slate-500 uppercase tracking-wider text-[10px]">
            Field notes{notes.names.length > 0 ? ` · ${notes.names.join(', ')}` : ''}{notes.returning ? ' · back again' : ''}
          </div>
          {notes.notes.length === 0
            ? <p className="text-slate-500">Nothing on this visitor yet.</p>
            : <ul id="mind-notes" className="flex flex-col gap-0.5 text-slate-300">{notes.notes.map((note) => <li key={note}>· {note}</li>)}</ul>}
          {notes.quotes.length > 0 && (
            <>
              <div className="text-slate-500 uppercase tracking-wider text-[10px] mt-1">Overheard tonight</div>
              <ul id="mind-quotes" className="flex flex-col gap-0.5 text-slate-400 italic">{notes.quotes.slice(0, 4).map((quote) => <li key={quote}>"{quote}"</li>)}</ul>
            </>
          )}
        </section>
      </div>
    </article>
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
