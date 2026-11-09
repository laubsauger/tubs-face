import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { splitLeadingEmoji, splitLineEmojis } from '../../chat/emoji.js';
import { chatTailKey, nearBottom } from '../../chat/scroll.js';
import { withFillerLeads } from '../../chat/filler-lead.js';
import { sendChatComposer } from '../../chat/send.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { isChatEntryVisible, formatTimestamp, renderChatPrefix, resolveChatActor } from '../utils/formatters.js';

export function ChatPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    chatComposerText: current.chatComposerText,
    chatEntries: current.chatEntries,
    chatVerbosity: current.chatVerbosity,
  }));
  const listRef = useRef<HTMLUListElement | null>(null);
  const [sending, setSending] = useState(false);

  const entries = withFillerLeads(state.chatEntries.filter((entry) => isChatEntryVisible(state.chatVerbosity, entry.type)));

  // Follow the newest line unless the reader scrolled up to read; keyed on the
  // newest line itself, so replaced drafts and growing lines scroll too.
  const stickRef = useRef(true);
  const tailKey = chatTailKey(entries);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [tailKey]);

  // Lines that arrive while the Chat tab is closed can't scroll a hidden list;
  // start at the newest line once the tab shows it again.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    let wasHidden = list.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      const hidden = list.clientHeight === 0;
      if (wasHidden && !hidden) list.scrollTop = list.scrollHeight;
      wasHidden = hidden;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) {
      return;
    }
    setSending(true);
    try {
      await sendChatComposer(store);
    } finally {
      setSending(false);
    }
  }

  return (
    <section id="chat-panel-card" className="dock-section dock-section-fill">
      <PanelHeader title="Chat Log" meta={`${state.chatEntries.length} msgs`} />

      <div className="panel-body panel-chat-body flex flex-col flex-1 min-h-0">
        <ul
          id="chat-log-list"
          ref={listRef}
          onScroll={(event) => {
            const list = event.currentTarget;
            stickRef.current = nearBottom(list.scrollHeight, list.scrollTop, list.clientHeight);
          }}
          className="chat-panel-list flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 font-mono text-xs"
        >
          {entries.length === 0
            ? <li className="text-slate-500 italic text-center mt-4">No chat yet.</li>
            : entries.map((entry) => {
              const actor = resolveChatActor(entry);
              const isAssistant = actor === 'main' || actor === 'small';
              const isSystem = actor === 'system';
              // Reply emojis go next to the name; the stored text keeps them.
              const { emoji, body } = isAssistant ? splitLeadingEmoji(entry.text) : { emoji: '', body: entry.text };
              // A bit has a reaction per sentence: shown in a faint column beside the text, not inline.
              const lines = isAssistant ? splitLineEmojis(body) : [];
              const perLine = lines.length > 1 && lines.some((line) => line.emoji);
              return (
                <li
                  key={entry.id}
                  className={`chat-entry chat-tone-${isAssistant ? actor : isSystem ? 'system' : 'user'} ${entry.filler ? 'is-filler' : ''} flex flex-col gap-1 ${isAssistant ? 'items-start' : isSystem ? 'items-center opacity-70' : 'items-end'} ${entry.draft ? 'opacity-50' : ''}`}
                >
                  <div className={`chat-entry-head flex items-baseline gap-2 text-[10px] ${isAssistant ? 'flex-row' : isSystem ? '' : 'flex-row-reverse'}`}>
                    <strong className="chat-entry-name uppercase tracking-wider">{renderChatPrefix(entry.type, entry.actor)}</strong>
                    {emoji && !perLine ? <span className="chat-entry-emoji" aria-label="reaction">{emoji}</span> : null}
                    {entry.filler ? <span className="text-slate-500">filler</span> : null}
                    <span className="text-slate-600">{formatTimestamp(entry.ts)}</span>
                  </div>
                  <div className={`chat-entry-card px-3 py-2 rounded-xl max-w-[90%] whitespace-pre-wrap break-words ${isAssistant ? 'rounded-tl-sm' : isSystem ? 'text-center italic text-[11px]' : 'rounded-tr-sm'}`}>
                    {entry.lead ? <span className="chat-entry-lead">{entry.lead} </span> : null}
                    {perLine
                      ? (
                        <div className="chat-entry-lines grid grid-cols-[1.4em_1fr] gap-x-1">
                          {lines.map((line, index) => (
                            <div key={index} className="contents">
                              <span className="chat-entry-line-emoji text-[10px] opacity-50 select-none" aria-label="reaction">{line.emoji || (index === 0 ? emoji : '')}</span>
                              <span>{line.text}</span>
                            </div>
                          ))}
                        </div>
                      )
                      : body}
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
      </div>
    </section>
  );
}
