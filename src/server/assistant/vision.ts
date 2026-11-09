// What Tubs sees: camera pictures described for the reply prompt. A new
// visitor (appearance_frame) is looked at at once; while someone stays in view
// the face page sends a refresh (camera_frame) every visionRefreshMs. Who looks
// at them, and how many, is set in the runtime config (docs/vision.md): off,
// Gemini, or any OpenAI-compatible server, under an hourly cap.

import type { VisionStats } from '../../shared/contracts/http.js';
import { updateVisualContext } from './context.js';
import { runtimeConfig } from '../config/runtime.js';
import { estimateCostUsd } from './text.js';
import { createVisionBudget, type VisionPictureKind } from '../vision/budget.js';
import { createFleetResolver } from '../vision/fleet.js';
import { askGemini, askOpenAiCompatible, defaultVisionDeps, type VisionProviderDeps } from '../vision/providers.js';
import { createVisionStats } from '../vision/stats.js';

export const VISION_SYSTEM = 'You are a visual context extraction tool.';
// Factual inventory; Tubs adds the attitude. Same prompt for a new visitor
// (appearance_frame) and the periodic refresh (camera_frame), so the first
// impression includes clothing too. The same for every provider.
// Position labels only with several people: with one, qwen3-vl wrote "Left:"
// and sometimes "Right: no other people".
export const VISION_PROMPT = 'Describe what the camera sees for a robot host: each person\'s clothing, accessories, hair colour and expression; anything they hold; the setting. If only one person is visible, write about them directly, with no label (for example "A person in a red coat, ..."). If two or more people are visible, go left to right as the image shows them and start each person with Left:, Middle: or Right: (labels are for people only). Never mention people who are not there. Factual. Under 60 words.';
const MAX_TOKENS = 100;

const OPENAI_IN_PER_MTOKENS = Number.parseFloat(process.env.VISION_INPUT_COST_PER_MTOKENS || '0') || 0;
const OPENAI_OUT_PER_MTOKENS = Number.parseFloat(process.env.VISION_OUTPUT_COST_PER_MTOKENS || '0') || 0;

export interface VisionService {
  /** Describe this picture if the budget allows; the description, or null (skipped, failed, timed out). */
  look(frameDataUrl: string, kind: VisionPictureKind): Promise<string | null>;
  /** Tubs fell asleep or woke up (refreshes pause while asleep). */
  noteSleeping(sleeping: boolean): void;
  /** VISION_API_KEY, set live through POST /config (never sent back). */
  setApiKey(key: string): void;
  stats(): VisionStats;
}

export interface VisionServiceOptions {
  deps?: Partial<VisionProviderDeps>;
  now?: () => number;
  /** The studio-manager hub that resolves fleet:vision. */
  hub?: string;
  log?: (message: string) => void;
}

export function createVisionService(options: VisionServiceOptions = {}): VisionService {
  const deps: VisionProviderDeps = { ...defaultVisionDeps, ...options.deps };
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(`[Vision] ${message}`));
  const budget = createVisionBudget({ now, log });
  const fleet = createFleetResolver({ hub: options.hub ?? (process.env.FLEET_HUB?.trim() || 'http://127.0.0.1:4310'), fetch: deps.fetch, now, log });
  const counters = createVisionStats();
  let apiKey = process.env.VISION_API_KEY?.trim() ?? '';
  let sleeping = false;

  return {
    async look(frameDataUrl, kind) {
      if (!/^data:image\/[\w+.-]+;base64,/.test(frameDataUrl)) return null;
      const config = runtimeConfig;
      const admitted = budget.admit(kind, {
        off: config.visionProvider === 'off',
        sleeping,
        whileAsleep: config.visionWhileAsleep,
        maxPerHour: config.visionMaxPerHour,
      });
      if (!admitted.ok) {
        counters.skip(admitted.reason);
        return null;
      }
      const provider = config.visionProvider === 'openai' ? 'openai' : 'gemini';
      const ask = {
        dataUrl: frameDataUrl,
        system: VISION_SYSTEM,
        prompt: VISION_PROMPT,
        model: config.visionModel || (provider === 'gemini' ? config.llmModel : ''),
        timeoutMs: config.visionTimeoutMs,
        maxTokens: MAX_TOKENS,
      };
      const started = now();
      let base: string | null = null;
      try {
        let answer;
        if (provider === 'openai') {
          base = config.visionBaseUrl === 'fleet:vision' ? await fleet.resolve() : config.visionBaseUrl;
          if (!base) throw new Error(config.visionBaseUrl === 'fleet:vision' ? 'fleet:vision: no provider found' : 'VISION_BASE_URL is not set');
          answer = await askOpenAiCompatible({ ...ask, base, apiKey }, deps);
        } else {
          answer = await askGemini(ask, deps);
        }
        const ms = now() - started;
        const costUsd = provider === 'gemini'
          ? estimateCostUsd(answer.tokensIn, answer.tokensOut)
          : (answer.tokensIn / 1e6) * OPENAI_IN_PER_MTOKENS + (answer.tokensOut / 1e6) * OPENAI_OUT_PER_MTOKENS;
        counters.call(provider, { ok: Boolean(answer.text), ms, tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, costUsd, base, at: now() });
        if (!answer.text) {
          // qwen3-vl:4b (the thinking variant) spends every token thinking and says nothing.
          log(`${provider} ${ask.model} answered with no text (${kind})${provider === 'openai' ? '; a thinking model does that: use an -instruct one' : ''}; keeping the last description`);
          return null;
        }
        log(`${provider} ${ask.model} (${kind}, ${Math.round(ms)} ms): ${answer.text}`);
        updateVisualContext(answer.text, now());
        return answer.text;
      } catch (error) {
        const ms = now() - started;
        counters.call(provider, { ok: false, ms, base });
        // The fleet's next box gets the next picture; the last description stays.
        if (base && config.visionBaseUrl === 'fleet:vision') fleet.fail(base);
        const reason = error instanceof Error ? (error.name === 'TimeoutError' || error.name === 'AbortError' ? `timed out after ${config.visionTimeoutMs} ms` : error.message) : String(error);
        log(`${provider} failed (${kind}): ${reason}; keeping the last description`);
        return null;
      }
    },
    noteSleeping(next) {
      sleeping = next;
    },
    setApiKey(key) {
      apiKey = key.trim();
    },
    stats() {
      return counters.view({
        provider: runtimeConfig.visionProvider,
        model: runtimeConfig.visionModel || (runtimeConfig.visionProvider === 'gemini' ? runtimeConfig.llmModel : ''),
        usedThisHour: budget.usedThisHour(),
        maxPerHour: runtimeConfig.visionMaxPerHour,
      });
    },
  };
}

export const visionService = createVisionService();

export function processVisualContext(frameDataUrl: string, kind: VisionPictureKind = 'refresh'): Promise<string | null> {
  return visionService.look(frameDataUrl, kind);
}
