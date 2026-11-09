// The Studio tab's vision picker, so nobody has to know base URLs or model
// tags: the servers to pick from (Ollama on this machine, the fleet, each
// fleet vision box by name) and the models a server has, with a warning on
// thinking variants (they spend every token thinking and answer nothing).

import type { VisionModel, VisionModelsResponse, VisionServer, VisionServersResponse } from '../../shared/contracts/vision.js';

export const OLLAMA_HERE = 'http://127.0.0.1:11434/v1';
const HUB_TIMEOUT_MS = 2500;
const MODELS_TIMEOUT_MS = 2500;

interface HubProvider {
  id?: unknown;
  label?: unknown;
  serverBase?: unknown;
  lanBases?: unknown;
  healthy?: unknown;
}

export async function visionServers(hub: string, doFetch: typeof fetch = fetch): Promise<VisionServersResponse> {
  const presets: VisionServer[] = [
    { label: 'Ollama on this machine', baseUrl: OLLAMA_HERE, healthy: null },
    { label: 'Ollama via the fleet (the hub picks a box)', baseUrl: 'fleet:vision', healthy: null },
  ];
  try {
    const response = await doFetch(`${hub.replace(/\/+$/, '')}/api/fleet/providers?kind=vision`, { signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    const body = (await response.json()) as { providers?: HubProvider[] };
    const boxes = (body.providers ?? []).flatMap((provider): VisionServer[] => {
      const lan = Array.isArray(provider.lanBases) ? provider.lanBases.find((base): base is string => typeof base === 'string') : undefined;
      const base = lan ?? (typeof provider.serverBase === 'string' ? provider.serverBase : null);
      if (!base) return [];
      const name = typeof provider.label === 'string' && provider.label ? provider.label : String(provider.id ?? base);
      return [{ label: name, baseUrl: `${base.replace(/\/+$/, '')}/v1`, healthy: provider.healthy === true }];
    });
    return { servers: [...presets, ...boxes] };
  } catch (error) {
    return { servers: presets, problem: `the fleet hub ${hub} does not answer (${error instanceof Error ? error.message : String(error)}); fleet boxes not listed` };
  }
}

/** A thinking variant: it may spend every token thinking and say nothing. */
export function thinkingWarning(id: string): string | undefined {
  const name = id.toLowerCase();
  if (name.includes('instruct')) return undefined;
  if (name.includes('thinking') || /^qwen3(?:\.\d+)?-vl\b/.test(name)) return 'thinks before it answers: often an empty answer; use an -instruct model';
  return undefined;
}

/** The model to use instead of a thinking one: its -instruct sibling if listed, else one with -instruct in its name. */
export function suggestedModel(models: VisionModel[]): string | undefined {
  const warned = models.find((model) => model.warning);
  if (!warned) return undefined;
  const ids = models.map((model) => model.id);
  const [name, tag = 'latest'] = warned.id.split(':');
  const sibling = tag === 'latest' ? undefined : `${name}:${tag}-instruct`;
  if (sibling && ids.includes(sibling)) return sibling;
  return ids.find((id) => id.startsWith(`${name}:`) && id.includes('instruct')) ?? sibling;
}

/** The models a server offers: OpenAI-compatible /models, else Ollama's /api/tags. */
export async function visionModels(base: string, doFetch: typeof fetch = fetch): Promise<VisionModelsResponse> {
  const clean = base.replace(/\/+$/, '');
  const asList = (ids: string[]): VisionModelsResponse => {
    const models = [...new Set(ids)].sort().map((id) => ({ id, ...(thinkingWarning(id) ? { warning: thinkingWarning(id)! } : {}) }));
    const suggested = suggestedModel(models);
    return { base, models, ...(suggested ? { suggested } : {}) };
  };
  const get = async (url: string) => {
    const response = await doFetch(url, { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  let first: unknown;
  try {
    const body = await get(`${clean}/models`);
    const data = Array.isArray(body.data) ? body.data : [];
    return asList(data.map((entry) => (entry as { id?: unknown }).id).filter((id): id is string => typeof id === 'string'));
  } catch (error) {
    first = error;
  }
  try {
    // Ollama names its models at /api/tags (its OpenAI side may be older or off).
    const body = await get(`${new URL(clean).origin}/api/tags`);
    const tags = Array.isArray(body.models) ? body.models : [];
    return asList(tags.map((entry) => (entry as { name?: unknown }).name).filter((id): id is string => typeof id === 'string'));
  } catch {
    return { base, models: [], error: `no model list from ${clean} (${first instanceof Error ? first.message : String(first)})` };
  }
}
