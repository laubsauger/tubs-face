import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { isChatEntryVisible, formatTimestamp, renderChatPrefix, resolveChatActor } from '../utils/formatters.js';

export function ChatPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.chat),
    chatPanelWidth: current.chatPanelWidth,
    chatEntries: current.chatEntries,
    chatVerbosity: current.chatVerbosity,
  }));

  const entries = state.chatEntries.filter((entry) => isChatEntryVisible(state.chatVerbosity, entry.type));

  return (
    <section
      id="chat-panel-card"
      className={`bg-slate-900/90 backdrop-blur-xl border border-slate-700 shadow-2xl rounded-2xl overflow-hidden transition-all flex flex-col relative max-w-[100vw] ${state.collapsed ? 'h-11' : 'h-[40vh]'}`}
      style={state.chatPanelWidth ? { width: state.chatPanelWidth } : { width: '420px' }}
    >
      <PanelHeader store={store} panelKey="chat" title="Chat Log" meta={`${state.chatEntries.length} msgs`} />
      
      <div className={`flex flex-col flex-1 min-h-0 overflow-hidden relative ${state.collapsed ? 'hidden' : ''}`}>
        <ul id="chat-log-list" className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3 font-mono text-xs">
          {entries.length === 0
            ? <li className="text-slate-500 italic text-center mt-4">No chat yet.</li>
            : entries.map((entry) => {
              const actor = resolveChatActor(entry);
              const isAssistant = actor === 'main' || actor === 'small';
              const isSystem = actor === 'system';
              return (
                <li key={entry.id} className={`flex flex-col gap-1 ${isAssistant ? 'items-start' : isSystem ? 'items-center opacity-70' : 'items-end'} ${entry.draft ? 'opacity-50' : ''}`}>
                  <div className={`flex items-baseline gap-2 text-[10px] ${isAssistant ? 'text-cyan-400/80 flex-row' : isSystem ? 'text-slate-500' : 'text-emerald-400/80 flex-row-reverse'}`}>
                    <strong className="uppercase tracking-wider">{renderChatPrefix(entry.type, entry.actor)}</strong>
                    <span className="text-slate-600">{formatTimestamp(entry.ts)}</span>
                  </div>
                  <div className={`px-3 py-2 rounded-xl max-w-[90%] whitespace-pre-wrap break-words ${isAssistant ? 'bg-slate-800 text-slate-300 rounded-tl-sm border border-slate-700' : isSystem ? 'bg-transparent text-slate-500 text-center italic text-[11px]' : 'bg-emerald-900/40 text-emerald-200 rounded-tr-sm border border-emerald-800/50'}`}>
                    {entry.text}
                  </div>
                </li>
              );
            })}
        </ul>
        {/* Resize handle expected by window-runtime event listener */}
        <div id="chat-panel-resize" className="panel-resize-handle absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-slate-500/20 active:bg-slate-500/40 transition-colors z-10" aria-hidden="true" />
      </div>
    </section>
  );
}
