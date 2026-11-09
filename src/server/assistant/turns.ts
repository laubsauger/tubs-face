import type { WsInterruptServerMessage, WsServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import { createTurnTimer, type TurnTimer } from '../turn-timing.js';
import { logConversation, logTubsReply } from '../observability/conversation-log.js';
import { captureTurnTrace } from '../observability/langfuse.js';
import { noteReplyEmoji, noteReplyLines, noteSmallEmoji } from './variety.js';
import type { SpokenLine } from './bits.js';
import { forgetConversation } from './context.js';
import { endVisit, noteTurn } from './field-notes.js';
import { hasActiveAssistantTurn, interruptAssistantTurns, runAssistantTurn, runProactiveTurn, type AssistantTurnResult } from './service.js';
import { noteHeard } from '../studio/pulse.js';

/**
 * Every way a turn can start (typed chat over HTTP or WS, a voice clip, a
 * greeting, a proactive nudge) goes through here, so mute, barge-in, the
 * conversation window and the pending greeting are handled the same way.
 */

type Broadcast = (message: WsServerMessage) => void;

/** After a reply, follow-up speech within this window needs no wake word. */
export const CONVERSATION_WINDOW_MS = 45_000;
const APPEARANCE_GREETING_DEBOUNCE_MS = 700;
/** Flickering recognition, or two open tabs with the camera on, can each report an arrival. */
export const APPEARANCE_GREETING_COOLDOWN_MS = 30_000;
let lastAppearanceGreetingAt = -Infinity;

let lastConversationAt = 0;
let pendingGreetingTimer: NodeJS.Timeout | null = null;
let pendingGreetingPrompt = '';

export function isInConversation(now = Date.now()): boolean {
  return now - lastConversationAt < CONVERSATION_WINDOW_MS;
}

export function endConversation(): void {
  lastConversationAt = 0;
}

/** Someone spoke this recently: they are still here, whatever the camera says. */
export const STILL_TALKING_MS = 20_000;

/**
 * The camera has seen nobody for minutes. Unless someone spoke just now
 * (camera blocked, visitor talking off to the side), the next face is a new
 * person and should not hear about the last one's jacket.
 */
export function onVisitorLeft(now = Date.now()): boolean {
  if (now - lastConversationAt < STILL_TALKING_MS) {
    return false;
  }
  forgetVisitor('visitor left');
  return true;
}

/** The face saw a different person than the last visitor come into view. */
export function onNewVisitor(): void {
  forgetVisitor('new visitor');
}

function forgetVisitor(reason: string): void {
  cancelAppearanceGreeting();
  endConversation();
  forgetConversation();
  endVisit();
  console.log(`[turn] ${reason}; conversation forgotten`);
}

/** What Tubs is told when someone comes into view. */
export function appearancePrompt(names: string[], returning: boolean, awayMs = 0): string {
  const who = names.length > 0 ? names.join(' and ') : 'The person you were talking to';
  if (returning) {
    const away = awayMs >= 90_000 ? `${Math.round(awayMs / 60_000)} minutes` : `${Math.round(awayMs / 1000)} seconds`;
    return `${who} is back after stepping away for about ${away}. React to them coming back, your way.`;
  }
  return names.length > 0
    ? `Known person nearby: ${who}. Greet them by name, on your terms.`
    : 'Someone new is nearby and has not spoken. Say something, on your terms.';
}

function interruptCurrentTurn(broadcast: Broadcast, source: NonNullable<WsInterruptServerMessage['source']>): void {
  const interruptedTurnId = interruptAssistantTurns();
  broadcast({
    type: 'interrupt',
    ...(interruptedTurnId ? { turnId: interruptedTurnId } : {}),
    source,
  });
}

export interface StartUserTurnArgs {
  text: string;
  source: 'text' | 'voice';
  broadcast: Broadcast;
  turnTimer?: TurnTimer;
}

/**
 * Accepts a user utterance and runs the reply. Returns null when the input is
 * dropped (muted). The returned promise settles when the reply has finished,
 * so HTTP handlers should answer the request before awaiting it.
 */
export function startUserTurn(args: StartUserTurnArgs): Promise<AssistantTurnResult> | null {
  const { text, source, broadcast } = args;
  if (source === 'voice') noteHeard(text);
  cancelAppearanceGreeting();
  if (runtimeConfig.muted) {
    broadcast({ type: 'expression', expression: 'idle' });
    return null;
  }

  interruptCurrentTurn(broadcast, source === 'voice' ? 'voice_barge_in' : 'user');
  sessionStats.messagesIn += 1;
  sessionStats.lastActivity = Date.now();
  lastConversationAt = Date.now();

  broadcast({ type: 'incoming', text });
  broadcast({ type: 'conversation_mode', active: true, expiresIn: CONVERSATION_WINDOW_MS });
  broadcast({ type: 'thinking' });

  const turnTimer = args.turnTimer ?? createTurnTimer({ side: 'backend', source, startedAt: Date.now() });
  turnTimer.setMeta('User', text);
  const startedAt = Date.now();
  void logConversation(source === 'voice' ? 'USER' : 'USER (typed)', text);
  return runTimedTurn(turnTimer, broadcast, () => runAssistantTurn(text, broadcast, turnTimer, { filler: source === 'voice' }))
    .then((result) => {
      recordTurn(source, text, result, startedAt, turnTimer);
      return result;
    })
    .catch((error: unknown) => {
      // Someone just spoke to Tubs; silence reads as broken. TTS is local, so
      // a canned line still works when the LLM (network, quota) does not.
      if (!hasActiveAssistantTurn()) {
        broadcast({ type: 'speak', text: pickFallbackLine(), ts: Date.now() });
      }
      throw error;
    });
}

const FALLBACK_LINES = [
  'My cloud brain just dropped the call. Say that again?',
  'Hold on, my brain is buffering. Try me again.',
  'I lost my train of thought somewhere in a data center. One more time?',
];
let fallbackIndex = 0;

function pickFallbackLine(): string {
  const line = FALLBACK_LINES[fallbackIndex % FALLBACK_LINES.length]!;
  fallbackIndex += 1;
  return line;
}

async function runTimedTurn(
  turnTimer: TurnTimer,
  broadcast: Broadcast,
  run: () => Promise<AssistantTurnResult>,
): Promise<AssistantTurnResult> {
  const endSpan = turnTimer.span('LLM Generation');
  try {
    const result = await run();
    endSpan();
    if (result.superseded) {
      turnTimer.mark('Assistant turn superseded');
    }
    return result;
  } catch (error) {
    endSpan();
    turnTimer.mark('Assistant turn failed');
    console.error('[turn] assistant turn failed', error);
    broadcast({ type: 'error', text: error instanceof Error ? error.message : 'Response generation failed' });
    throw error;
  } finally {
    turnTimer.log({ title: '[Turn Timing]' });
  }
}

/** A turn Tubs starts on its own: a greeting or a proactive line. */
export function startProactiveTurn(context: string, broadcast: Broadcast): void {
  cancelAppearanceGreeting();
  if (runtimeConfig.muted || !context.trim()) {
    return;
  }
  // Tubs speaking up on his own never kills a reply someone is waiting for.
  if (hasActiveAssistantTurn()) {
    console.log('[turn] proactive line skipped: a reply is still being generated');
    return;
  }
  interruptCurrentTurn(broadcast, 'system');
  sessionStats.messagesIn += 1;
  sessionStats.lastActivity = Date.now();
  broadcast({ type: 'thinking' });
  const startedAt = Date.now();
  // "thinking" went out above; without a reply nothing else would clear it
  // and the face stayed looking away with the thinking bar up.
  const clearThinking = () => {
    if (!hasActiveAssistantTurn()) broadcast({ type: 'expression', expression: 'idle' });
  };
  void runProactiveTurn(context, broadcast)
    .then((result) => {
      if (result) recordTurn('proactive', context, result, startedAt);
      else clearThinking();
    })
    .catch((error: unknown) => {
      console.error('[turn] proactive turn failed', error);
      clearThinking();
    });
}

/** Transcript line and Langfuse trace for every reply that was actually given. */
function recordTurn(source: 'text' | 'voice' | 'proactive', input: string, result: AssistantTurnResult, startedAt: number, turnTimer?: TurnTimer): void {
  if (source !== 'proactive') noteTurn();
  if (!result.superseded) {
    void logTubsReply(result.reply.text, result.beats);
    noteReplyEmoji(result.reply.emotion?.emoji);
    noteSmallEmoji(result.beats?.filter((beat) => beat.actor === 'small').at(-1)?.emotion?.emoji);
    // A proactive turn's input is our own prompt, not the visitor's words.
    noteReplyLines(spokenLines(result), Date.now(), source === 'proactive' ? '' : input);
  }
  captureTurnTrace({ source, userText: input, result, startedAt, ...(turnTimer ? { turnTimer } : {}) });
}

/** Who said what: each head's speak beats in a two-head turn, else Tubs alone. */
function spokenLines(result: Pick<AssistantTurnResult, 'reply' | 'beats'>): SpokenLine[] {
  if (!result.beats) return [{ head: 'main', text: result.reply.text }];
  return result.beats
    .filter((beat) => beat.action === 'speak' && beat.text?.trim())
    .map((beat) => ({ head: beat.actor === 'small' ? 'small' : 'main', text: beat.text ?? '' }));
}

/**
 * Debounced greeting when a face appears. Any user turn in the meantime
 * cancels it, and it never interrupts a reply that is already running.
 */
export function scheduleAppearanceGreeting(prompt: string, broadcast: Broadcast): void {
  pendingGreetingPrompt = prompt;
  if (pendingGreetingTimer) {
    clearTimeout(pendingGreetingTimer);
  }
  pendingGreetingTimer = setTimeout(() => {
    pendingGreetingTimer = null;
    const nextPrompt = pendingGreetingPrompt;
    pendingGreetingPrompt = '';
    if (!nextPrompt || hasActiveAssistantTurn()) {
      return;
    }
    const sinceLast = Date.now() - lastAppearanceGreetingAt;
    if (sinceLast < APPEARANCE_GREETING_COOLDOWN_MS) {
      console.log(`[Greeting] Skipped, greeted ${Math.round(sinceLast / 1000)} s ago`);
      return;
    }
    lastAppearanceGreetingAt = Date.now();
    startProactiveTurn(nextPrompt, broadcast);
  }, APPEARANCE_GREETING_DEBOUNCE_MS);
}

export function cancelAppearanceGreeting(): void {
  if (pendingGreetingTimer) {
    clearTimeout(pendingGreetingTimer);
    pendingGreetingTimer = null;
  }
  pendingGreetingPrompt = '';
}
