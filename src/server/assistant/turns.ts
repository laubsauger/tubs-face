import type { WsInterruptServerMessage, WsServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import { createTurnTimer, type TurnTimer } from '../turn-timing.js';
import { logConversation, logTubsReply } from '../observability/conversation-log.js';
import { captureTurnTrace } from '../observability/langfuse.js';
import { noteReplyEmoji } from './variety.js';
import { forgetConversation } from './context.js';
import { hasActiveAssistantTurn, interruptAssistantTurns, runAssistantTurn, runProactiveTurn, type AssistantTurnResult } from './service.js';

/**
 * Every way a turn can start (typed chat over HTTP or WS, a voice clip, a
 * greeting, a proactive nudge) goes through here, so mute, barge-in, the
 * conversation window and the pending greeting are handled the same way.
 */

type Broadcast = (message: WsServerMessage) => void;

/** After a reply, follow-up speech within this window needs no wake word. */
export const CONVERSATION_WINDOW_MS = 45_000;
const APPEARANCE_GREETING_DEBOUNCE_MS = 700;

let lastConversationAt = 0;
let pendingGreetingTimer: NodeJS.Timeout | null = null;
let pendingGreetingPrompt = '';

export function isInConversation(now = Date.now()): boolean {
  return now - lastConversationAt < CONVERSATION_WINDOW_MS;
}

export function endConversation(): void {
  lastConversationAt = 0;
}

/** The face saw nobody for this long before reporting the visitor gone. */
export const VISITOR_GONE_MS = 20_000;

/**
 * The camera has seen nobody for a while. Unless someone spoke in that time
 * (camera blocked, visitor still talking), the next face is a new person and
 * should not hear about the last one's jacket.
 */
export function onVisitorLeft(now = Date.now()): boolean {
  if (now - lastConversationAt < VISITOR_GONE_MS) {
    return false;
  }
  cancelAppearanceGreeting();
  endConversation();
  forgetConversation();
  console.log('[turn] visitor left; conversation forgotten');
  return true;
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
  interruptCurrentTurn(broadcast, 'system');
  sessionStats.messagesIn += 1;
  sessionStats.lastActivity = Date.now();
  broadcast({ type: 'thinking' });
  const startedAt = Date.now();
  void runProactiveTurn(context, broadcast)
    .then((result) => {
      if (result) recordTurn('proactive', context, result, startedAt);
    })
    .catch((error: unknown) => {
      console.error('[turn] proactive turn failed', error);
    });
}

/** Transcript line and Langfuse trace for every reply that was actually given. */
function recordTurn(source: 'text' | 'voice' | 'proactive', input: string, result: AssistantTurnResult, startedAt: number, turnTimer?: TurnTimer): void {
  if (!result.superseded) {
    void logTubsReply(result.reply.text, result.beats);
    noteReplyEmoji(result.reply.emotion?.emoji);
  }
  captureTurnTrace({ source, userText: input, result, startedAt, ...(turnTimer ? { turnTimer } : {}) });
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
