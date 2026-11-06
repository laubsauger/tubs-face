// The last few chat lines at the bottom left of the stage, so the operator can
// follow the conversation with the dock folded or on another tab. Also holds a
// compact input that typing lands in when the Chat tab is not on screen.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { readVoiceClock } from '../../audio/voice-clock.js';
import type { AppStore } from '../../state/app-state.js';
import { sendChatComposer } from '../../chat/send.js';
import { useAppSelector } from '../react-store.js';
import { openDockTab } from './dock-state.js';
import {
  TRANSCRIPT_HOLD_MS,
  isTranscriptShown,
  nextTyping,
  revealedChars,
  selectTranscriptLines,
  transcriptKey,
  type TranscriptLine,
  type Typing,
} from './transcript.js';

const SPEAKER: Record<TranscriptLine['actor'], string> = { user: 'Guest', main: 'Tubs', small: 'Mini' };

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The typed part shows; the rest keeps its place, so the card doesn't grow line by line. */
function writeTyped(node: HTMLElement | null, text: string, shown: number): void {
  // By class: a filler's lead-in may sit in front of them.
  const typed = node?.querySelector('.transcript-typed');
  const untyped = node?.querySelector('.transcript-untyped');
  if (!typed || !untyped) return;
  typed.textContent = text.slice(0, shown);
  untyped.textContent = text.slice(shown);
}

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
  const [typedAt, setTypedAt] = useState(0);
  const [clipped, setClipped] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const linesBoxRef = useRef<HTMLButtonElement>(null);
  const typedRef = useRef<HTMLSpanElement>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // Which line types out. Worked out from the lines alone (calling it again
  // with the same lines changes nothing), so a re-render for anything else
  // never restarts it. Lines already up when this mounts stay whole.
  const typingRef = useRef<Typing | null>(null);
  const previousIdsRef = useRef<ReadonlySet<string> | null>(null);
  const lineIds = new Set(lines.map((line) => line.id));
  if (previousIdsRef.current) {
    const instant = !state.enabled || state.chatTabVisible || prefersReducedMotion();
    typingRef.current = nextTyping(typingRef.current, previousIdsRef.current, lines, performance.now(), instant);
  }
  previousIdsRef.current = lineIds;
  const typing = typingRef.current;
  const typingLine = typing ? lines.find((line) => line.id === typing.id) : undefined;
  const typingId = typingLine && typing && typing.shown < typingLine.text.length ? typingLine.id : null;

  // One card at a time, one cheap DOM write when another character is due,
  // and nothing at all once it is typed out.
  useEffect(() => {
    if (!typingId) return undefined;
    let frame = 0;
    const tick = () => {
      const current = typingRef.current;
      const line = linesRef.current.find((item) => item.id === current?.id);
      if (!current || !line) return;
      const shown = revealedChars(current, line.text, readVoiceClock(), performance.now());
      if (shown !== current.shown) {
        current.shown = shown;
        writeTyped(typedRef.current, line.text, shown);
      }
      if (shown < line.text.length) {
        frame = requestAnimationFrame(tick);
      } else {
        setTypedAt(Date.now());
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [typingId, key]);

  // Keyed on the lines' content, not the entries array, which changes on every chat update.
  // A long reply can take longer to say than the hold, so the hold restarts once it is typed out.
  const hasLines = lines.length > 0;
  useEffect(() => {
    if (!hasLines) return undefined;
    setLastChangeAt(Date.now());
    // Re-render once the hold is over, so the lines fade out.
    const timer = window.setTimeout(() => setExpiredAt(Date.now()), TRANSCRIPT_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [key, hasLines, typedAt]);

  // Cards outgrowing the corner slide off the top: fade the cut edge.
  useLayoutEffect(() => {
    const box = linesBoxRef.current;
    if (!box) return undefined;
    const measure = () => {
      const first = box.firstElementChild;
      setClipped(Boolean(first && first.getBoundingClientRect().top < box.getBoundingClientRect().top - 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [key]);

  // A draft typed in the dock's chat input stays there; it doesn't open this one too.
  const composing = !state.perform && (focused || (state.draft.length > 0 && !state.chatTabVisible));
  // While the operator types, the lines stay up as context for the reply, and so
  // do they while a reply is still typing out.
  const shown = state.enabled && !state.chatTabVisible && lines.length > 0
    && (composing || typingId != null || isTranscriptShown(lastChangeAt, Date.now()));

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
        ref={linesBoxRef}
        type="button"
        className={`floating-transcript-lines ${shown ? 'is-shown' : ''} ${clipped ? 'is-clipped' : ''}`}
        aria-hidden={!shown}
        tabIndex={shown && !state.perform ? 0 : -1}
        title="Open the chat log"
        onClick={() => store.setState((current) => openDockTab(current, 'chat'))}
      >
        {lines.map((line) => {
          const typedLength = line.id === typingId && typing ? typing.shown : line.text.length;
          return (
            <span
              key={line.id}
              className={`transcript-line chat-tone-${line.actor} ${line.filler ? 'is-filler' : ''} ${line.draft ? 'is-draft' : ''}`}
            >
              <span className="transcript-speaker">
                {SPEAKER[line.actor]}
                {line.emoji ? <span className="transcript-emoji">{line.emoji}</span> : null}
                {line.filler ? <span className="transcript-filler-tag">filler</span> : null}
              </span>
              <span className="transcript-text" ref={line.id === typingId ? typedRef : undefined}>
                {line.lead ? <span className="transcript-lead">{line.lead} </span> : null}
                <span className="transcript-typed">{line.text.slice(0, typedLength)}</span>
                <span className="transcript-untyped" aria-hidden="true">{line.text.slice(typedLength)}</span>
              </span>
            </span>
          );
        })}
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
