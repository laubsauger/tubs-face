// The last few chat lines at the bottom left of the stage, so the operator can
// follow the conversation with the dock folded or on another tab. Also holds a
// compact input that typing lands in when the Chat tab is not on screen.

import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { sendChatComposer } from '../../chat/send.js';
import { useAppSelector } from '../react-store.js';
import { openDockTab } from './dock-state.js';
import { TRANSCRIPT_HOLD_MS, isTranscriptShown, selectTranscriptLines, transcriptKey, type TranscriptLine } from './transcript.js';

const SPEAKER: Record<TranscriptLine['actor'], string> = { user: 'Guest', main: 'Tubs', small: 'Mini' };

export function FloatingTranscript({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    entries: current.chatEntries,
    enabled: current.stage.transcript,
    perform: current.uiHidden,
    draft: current.chatComposerText,
    // The chat log is right there in the dock; no need to repeat it over the face.
    chatTabVisible: current.dockTab === 'chat' && !current.dockFolded && !current.uiHidden,
  }));
  const lines = useMemo(() => selectTranscriptLines(state.entries), [state.entries]);
  const key = transcriptKey(lines);
  const [lastChangeAt, setLastChangeAt] = useState<number | null>(null);
  const [, setExpiredAt] = useState(0);
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);

  // Keyed on the lines' content, not the entries array, which changes on every chat update.
  const hasLines = lines.length > 0;
  useEffect(() => {
    if (!hasLines) return undefined;
    setLastChangeAt(Date.now());
    // Re-render once the hold is over, so the lines fade out.
    const timer = window.setTimeout(() => setExpiredAt(Date.now()), TRANSCRIPT_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [key, hasLines]);

  // A draft typed in the dock's chat input stays there; it doesn't open this one too.
  const composing = !state.perform && (focused || (state.draft.length > 0 && !state.chatTabVisible));
  // While the operator types, the lines stay up as context for the reply.
  const shown = state.enabled && !state.chatTabVisible && lines.length > 0
    && (composing || isTranscriptShown(lastChangeAt, Date.now()));

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    try {
      if (await sendChatComposer(store)) {
        // Back to a clean stage; typing again brings the input back.
        (document.activeElement as HTMLElement | null)?.blur();
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`floating-transcript ${state.perform ? 'is-perform' : ''}`}>
      <button
        id="floating-transcript"
        type="button"
        className={`floating-transcript-lines ${shown ? 'is-shown' : ''}`}
        aria-hidden={!shown}
        tabIndex={shown && !state.perform ? 0 : -1}
        title="Open the chat log"
        onClick={() => store.setState((current) => openDockTab(current, 'chat'))}
      >
        {lines.map((line) => (
          <span
            key={line.id}
            className={`transcript-line chat-tone-${line.actor} ${line.filler ? 'is-filler' : ''} ${line.draft ? 'is-draft' : ''}`}
          >
            <span className="transcript-speaker">
              {SPEAKER[line.actor]}
              {line.emoji ? <span className="transcript-emoji">{line.emoji}</span> : null}
              {line.filler ? <span className="transcript-filler-tag">filler</span> : null}
            </span>
            <span className="transcript-text">{line.text}</span>
          </span>
        ))}
      </button>

      {state.perform ? null : (
        <form className={`quick-compose ${composing ? 'is-open' : ''}`} onSubmit={(event) => { void handleSubmit(event); }}>
          <input
            id="quick-chat-input"
            className="quick-compose-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Type to Tubs · Enter sends · Esc closes"
            aria-label="Type to Tubs"
            value={state.draft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              // Escape here only closes the input; it must not put Tubs to sleep.
              if (event.key === 'Escape') {
                event.stopPropagation();
                event.currentTarget.blur();
              }
            }}
            onChange={(event) => {
              const value = event.currentTarget.value;
              store.setState((current) => ({ ...current, chatComposerText: value }));
            }}
          />
        </form>
      )}
    </div>
  );
}
