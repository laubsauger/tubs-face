import { useEffect, useRef, useState, type FormEvent, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppStore } from '../../state/app-state.js';
import type { IncomingRequest, IncomingResponse } from '../../../shared/contracts/http.js';
import { postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { isChatEntryVisible, formatTimestamp, renderChatPrefix, resolveChatActor } from '../utils/formatters.js';

export function ChatPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.chat),
    chatPanelWidth: current.chatPanelWidth,
    chatComposerText: current.chatComposerText,
    chatEntries: current.chatEntries,
    chatVerbosity: current.chatVerbosity,
  }));
  const cardRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [sending, setSending] = useState(false);

  const entries = state.chatEntries.filter((entry) => isChatEntryVisible(state.chatVerbosity, entry.type));
  const panelWidth = state.chatPanelWidth ?? 420;

  useEffect(() => {
    const list = listRef.current;
    if (!list || state.collapsed) {
      return;
    }
    list.scrollTop = list.scrollHeight;
  }, [entries.length, state.collapsed]);

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = cardRef.current?.getBoundingClientRect().width ?? panelWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const maxWidth = Math.min(window.innerWidth - 32, 720);
      const nextWidth = Math.max(320, Math.min(maxWidth, startWidth + (moveEvent.clientX - startX)));
      store.setState((current) => ({
        ...current,
        chatPanelWidth: nextWidth,
      }));
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = state.chatComposerText.trim();
    if (!text || sending) {
      return;
    }

    setSending(true);
    store.setState((current) => ({
      ...current,
      chatComposerText: '',
    }));
    try {
      await postJson<IncomingRequest, IncomingResponse>('/incoming', { text });
    } catch (error) {
      store.setState((current) => ({
        ...current,
        chatComposerText: current.chatComposerText ? current.chatComposerText : text,
      }));
      store.appendLog('error', error instanceof Error ? error.message : 'Failed to send text turn');
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      id="chat-panel-card"
      ref={cardRef}
      className={`panel-surface panel-surface-chat flex flex-col relative max-w-[calc(100vw-32px)] ${state.collapsed ? 'is-collapsed h-11' : ''}`}
      style={state.collapsed ? undefined : { width: panelWidth }}
    >
      <PanelHeader store={store} panelKey="chat" title="Chat Log" meta={`${state.chatEntries.length} msgs`} />
      
      <div className={`panel-body panel-chat-body flex flex-col flex-1 min-h-0 overflow-hidden relative ${state.collapsed ? 'hidden' : ''}`}>
        <ul
          id="chat-log-list"
          ref={listRef}
          className="chat-panel-list flex-1 min-h-0 overflow-y-auto flex flex-col justify-end gap-3 font-mono text-xs"
        >
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

        <form className="chat-panel-compose" onSubmit={(event) => { void handleSubmit(event); }}>
          <input
            id="chat-panel-input"
            className="chat-panel-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Type to Tubs and press Enter"
            value={state.chatComposerText}
            onChange={(event) => {
              const value = event.currentTarget.value;
              store.setState((current) => ({
                ...current,
                chatComposerText: value,
              }));
            }}
          />
          <button className="button button-compact" type="submit" disabled={sending || !state.chatComposerText.trim()}>
            {sending ? 'Sending' : 'Send'}
          </button>
        </form>

        <div
          id="chat-panel-resize"
          className="panel-resize-handle"
          aria-hidden="true"
          onDoubleClick={() => {
            store.setState((current) => ({
              ...current,
              chatPanelWidth: null,
            }));
          }}
          onPointerDown={handleResizeStart}
        />
      </div>
    </section>
  );
}
