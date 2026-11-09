// Vision calls, failures, latency and estimated cost, per provider, for
// /stats: vision's cost shows on its own, next to the LLM's.

import type { VisionProviderStats, VisionStats } from '../../shared/contracts/http.js';

type Provider = 'gemini' | 'openai';
type Skip = keyof VisionStats['skipped'];

interface Counter {
  calls: number;
  failures: number;
  latencyTotal: number;
  latencyCount: number;
  lastLatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const blank = (): Counter => ({ calls: 0, failures: 0, latencyTotal: 0, latencyCount: 0, lastLatencyMs: null, tokensIn: 0, tokensOut: 0, costUsd: 0 });

export function createVisionStats() {
  const counters: Record<Provider, Counter> = { gemini: blank(), openai: blank() };
  const skipped: VisionStats['skipped'] = { off: 0, asleep: 0, cap: 0 };
  let lastDescriptionAt: number | null = null;
  let lastBase: string | null = null;
  let lastLatencyMs: number | null = null;

  const view = (counter: Counter): VisionProviderStats => ({
    calls: counter.calls,
    failures: counter.failures,
    avgLatencyMs: counter.latencyCount ? Math.round(counter.latencyTotal / counter.latencyCount) : null,
    lastLatencyMs: counter.lastLatencyMs,
    tokensIn: counter.tokensIn,
    tokensOut: counter.tokensOut,
    costUsd: Number(counter.costUsd.toFixed(6)),
  });

  return {
    skip(reason: Skip): void {
      skipped[reason] += 1;
    },
    call(provider: Provider, result: { ok: boolean; ms: number; tokensIn?: number; tokensOut?: number; costUsd?: number; base?: string | null; at?: number }): void {
      const counter = counters[provider];
      counter.calls += 1;
      if (!result.ok) counter.failures += 1;
      counter.latencyTotal += result.ms;
      counter.latencyCount += 1;
      counter.lastLatencyMs = Math.round(result.ms);
      lastLatencyMs = counter.lastLatencyMs;
      counter.tokensIn += result.tokensIn ?? 0;
      counter.tokensOut += result.tokensOut ?? 0;
      counter.costUsd += result.costUsd ?? 0;
      if (result.base !== undefined) lastBase = result.base;
      if (result.ok) lastDescriptionAt = result.at ?? Date.now();
    },
    view(current: { provider: string; model: string; usedThisHour: number; maxPerHour: number }): VisionStats {
      const all = blank();
      for (const counter of Object.values(counters)) {
        all.calls += counter.calls;
        all.failures += counter.failures;
        all.latencyTotal += counter.latencyTotal;
        all.latencyCount += counter.latencyCount;
        all.tokensIn += counter.tokensIn;
        all.tokensOut += counter.tokensOut;
        all.costUsd += counter.costUsd;
      }
      return {
        ...view(all),
        lastLatencyMs,
        provider: current.provider,
        model: current.model,
        baseUrl: lastBase,
        skipped: { ...skipped },
        usedThisHour: current.usedThisHour,
        maxPerHour: current.maxPerHour,
        lastDescriptionAt,
        byProvider: { gemini: view(counters.gemini), openai: view(counters.openai) },
      };
    },
  };
}

export type VisionStatsCollector = ReturnType<typeof createVisionStats>;
