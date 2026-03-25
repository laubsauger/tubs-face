import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { formatCurrency } from '../utils/formatters.js';

export function StatsPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.stats),
    stats: current.stats,
    config: current.config,
    currentExpression: current.currentExpression,
  }));

  return (
    <article className={`panel-surface panel-surface-compact transition-all text-left ${state.collapsed ? 'is-collapsed h-11' : ''}`}>
      <PanelHeader store={store} panelKey="stats" title="Bot Stats" meta={`$${(state.stats?.costUsd ?? 0).toFixed(4)}`} />
      <div className={`panel-body panel-content flex flex-col gap-3 ${state.collapsed ? 'hidden' : ''}`}>
        <div className="flex items-center gap-3 bg-slate-950/50 p-3 rounded-xl border border-slate-800">
          <div className="flex-1 font-mono text-xs text-slate-300">
            Expression: <span className="font-bold text-cyan-400 ml-1">{state.currentExpression || 'idle'}</span>
          </div>
        </div>

        <dl className="grid grid-cols-[90px_1fr] gap-x-2 gap-y-3 text-xs font-mono">
          <dt className="text-slate-500">Tokens In</dt>
          <dd className="text-slate-300 font-bold">{state.stats?.tokensIn?.toLocaleString() ?? 0}</dd>
          
          <dt className="text-slate-500">Tokens Out</dt>
          <dd className="text-slate-300 font-bold">{state.stats?.tokensOut?.toLocaleString() ?? 0}</dd>
          
          <dt className="text-slate-500">Cost USD</dt>
          <dd className="text-emerald-400 font-bold">{formatCurrency(state.stats?.costUsd)}</dd>
          
          <dt className="text-slate-500">Res. Time</dt>
          <dd className="text-slate-300 font-bold">n/a</dd>
        </dl>
      </div>
    </article>
  );
}
