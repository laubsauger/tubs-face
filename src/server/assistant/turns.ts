import type { WsInterruptServerMessage, WsServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import { createTurnTimer, type TurnTimer } from '../turn-timing.js';
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
  return runTimedTurn(turnTimer, broadcast, () => runAssistantTurn(text, broadcast, turnTimer));
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
  void runProactiveTurn(context, broadcast).catch((error: unknown) => {
    console.error('[turn] proactive turn failed', error);
  });
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
