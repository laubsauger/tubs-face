import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { formatTimestamp } from '../utils/formatters.js';
import { PanelHeader } from './PanelHeader.js';

/** What the face did and what went wrong (TTS failures, timeouts, mic errors), newest first. */
export function EventLogPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.eventLog),
    logs: current.logs,
  }));
  const errors = state.logs.filter((entry) => entry.level === 'error').length;

  return (
    <article className={`panel-surface panel-surface-compact transition-all text-left ${state.collapsed ? 'is-collapsed h-11' : ''}`}>
      <PanelHeader store={store} panelKey="eventLog" title="Event Log" meta={errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : `${state.logs.length}`} />
      <div className={`panel-body panel-content ${state.collapsed ? 'hidden' : ''}`}>
        <ul id="event-log-list" className="flex flex-col gap-1 max-h-64 overflow-y-auto font-mono text-[11px] leading-snug">
          {state.logs.length === 0
            ? <li className="text-slate-500">No events yet.</li>
            : state.logs.map((entry) => (
              <li key={entry.id} className={`grid grid-cols-[64px_1fr] gap-2 ${entry.level === 'error' ? 'text-rose-300' : 'text-slate-300'}`}>
                <span className="text-slate-500 tabular-nums">{formatTimestamp(entry.ts)}</span>
                <span className="break-words min-w-0">{entry.text}</span>
              </li>
            ))}
        </ul>
      </div>
    </article>
  );
}
