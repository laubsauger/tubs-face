import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { formatUptime, formatAwakeElapsed } from '../utils/formatters.js';

export function ConnectionPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.connection),
    connectionLabel: current.connectionLabel,
    connected: current.connected,
    health: current.health,
    awakeElapsedSec: current.awakeElapsedSec,
    stats: current.stats,
    config: current.config,
  }));

  return (
    <article className={`panel-surface panel-surface-compact transition-all ${state.collapsed ? 'is-collapsed h-11' : ''}`}>
      <PanelHeader store={store} panelKey="connection" title="System Vitals" meta={state.connected ? 'Online' : 'Offline'} />
      <div className={`panel-body panel-content flex flex-col gap-4 ${state.collapsed ? 'hidden' : ''}`}>
        <div className="flex items-center gap-3 bg-slate-950/50 p-3 rounded-xl border border-slate-800">
          <div className={`w-3 h-3 rounded-full shadow-[0_0_12px_rgba(0,0,0,0.5)] ${state.connected ? 'bg-emerald-500 shadow-emerald-500/50' : 'bg-red-500 shadow-red-500/50'} animate-pulse`} />
          <div className="flex-1 font-mono text-xs text-slate-300">
            {state.connectionLabel}
          </div>
        </div>

        <dl className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-3 text-xs font-mono">
          <dt className="text-slate-500">Uptime</dt>
          <dd className="text-slate-300 font-bold">{formatUptime(state.health)}</dd>
          
          <dt className="text-slate-500">Awake</dt>
          <dd className="text-slate-300 font-bold">{formatAwakeElapsed(state.awakeElapsedSec)}</dd>
          
          <dt className="text-slate-500">Model</dt>
          <dd className="text-cyan-400 font-bold truncate" title={state.stats?.model ?? state.config?.model ?? 'n/a'}>
            {state.stats?.model ?? state.config?.model ?? 'n/a'}
          </dd>
        </dl>
      </div>
    </article>
  );
}
