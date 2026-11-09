// How the last LLM call went (GET /studio parts: the brain), whichever
// provider made it. Aborted calls (a turn cut off) say nothing either way.

export interface LastLlmCall {
  ok: boolean;
  ms: number;
  model: string | null;
  at: number;
  error?: string;
}

let last: LastLlmCall | null = null;

export function lastLlmCall(): LastLlmCall | null {
  return last;
}

export function noteLlmCall(call: LastLlmCall): void {
  last = call;
}

export function resetLlmCall(): void {
  last = null;
}

/** Times a provider call and keeps how it went; the call's own result or error passes through. */
export async function trackLlmCall<T extends { model?: string; aborted?: boolean }>(run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const started = now();
  try {
    const result = await run();
    if (!result.aborted) noteLlmCall({ ok: true, ms: Math.round(now() - started), model: result.model ?? null, at: now() });
    return result;
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError');
    if (!aborted) noteLlmCall({ ok: false, ms: Math.round(now() - started), model: null, at: now(), error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    throw error;
  }
}
