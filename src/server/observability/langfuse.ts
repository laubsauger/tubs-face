import { Langfuse } from 'langfuse';
import type { AssistantTurnResult } from '../assistant/service.js';
import type { TurnTimer } from '../turn-timing.js';

/**
 * Langfuse tracing ported from main: one trace per turn with the user input,
 * the reply, one generation (model, tokens, cost) and the turn timing marks.
 * Off unless LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL
 * are set.
 */
let client: Langfuse | null = null;
let initialized = false;

function env(name: string): string {
  return String(process.env[name] ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function getClient(): Langfuse | null {
  if (initialized) return client;
  initialized = true;
  const publicKey = env('LANGFUSE_PUBLIC_KEY');
  const secretKey = env('LANGFUSE_SECRET_KEY');
  const baseUrl = env('LANGFUSE_BASE_URL');
  if (!publicKey || !secretKey || !baseUrl) {
    console.log('[Langfuse] Disabled (missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL)');
    return null;
  }
  try {
    client = new Langfuse({ publicKey, secretKey, baseUrl, flushAt: 10, flushInterval: 3000, requestTimeout: 5000 });
    console.log(`[Langfuse] Enabled (${baseUrl})`);
  } catch (error) {
    console.warn('[Langfuse] Failed to initialize:', error instanceof Error ? error.message : error);
    client = null;
  }
  return client;
}

export interface TurnTraceInput {
  source: 'text' | 'voice' | 'proactive';
  userText: string;
  result: AssistantTurnResult;
  turnTimer?: TurnTimer;
  startedAt: number;
}

export function captureTurnTrace({ source, userText, result, turnTimer, startedAt }: TurnTraceInput): void {
  const langfuse = getClient();
  if (!langfuse) return;
  try {
    const { reply } = result;
    const endedAt = Date.now();
    const trace = langfuse.trace({
      id: result.turnId,
      name: 'assistant_turn',
      timestamp: new Date(startedAt),
      input: { text: userText, source },
      output: { text: reply.text },
      tags: ['tubs-face', source, reply.source, ...(result.beats ? ['dual-head'] : [])],
      metadata: {
        superseded: Boolean(result.superseded),
        imageAttached: Boolean(reply.contextMeta?.imageAttached),
        historyMessages: reply.contextMeta?.historyMessages ?? 0,
        emotion: reply.emotion?.emoji ?? null,
      },
    });
    trace.generation({
      name: 'assistant_generation',
      model: reply.model,
      startTime: new Date(startedAt),
      endTime: new Date(endedAt),
      input: userText,
      output: result.beats ? { text: reply.text, beats: result.beats } : reply.text,
      usageDetails: { input: reply.tokens.in, output: reply.tokens.out, total: reply.tokens.in + reply.tokens.out },
      costDetails: { total: reply.costUsd },
    });
    if (turnTimer?.rows.length) {
      trace.event({
        name: 'turn_timing',
        metadata: {
          totalMs: endedAt - turnTimer.startedAt,
          events: turnTimer.rows.map((row) => ({ event: row.event, offsetMs: row.atMs - turnTimer.startedAt })),
        },
      });
    }
  } catch (error) {
    console.warn('[Langfuse] Failed to capture turn trace:', error instanceof Error ? error.message : error);
  }
}

/** Flush pending traces on shutdown, bounded so exit never hangs. */
export async function shutdownLangfuse(timeoutMs = 1500): Promise<void> {
  if (!client) return;
  await Promise.race([
    client.shutdownAsync().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
