// VISION_BASE_URL=fleet:vision: the vision box is whichever studio machine the
// studio-manager hub ranks first (studio-manager docs/providers-contract.md),
// so the model can move between boxes without a restart (docs/vision.md).

const PROVIDERS_PATH = '/api/fleet/providers?kind=vision&healthy=1';
export const FLEET_REFRESH_MS = 5 * 60_000;
const LAN_PROBE_TIMEOUT_MS = 1500;
const HUB_TIMEOUT_MS = 3000;

interface FleetProvider {
  id?: string;
  serverBase?: string;
  lanBases?: string[];
}

export interface FleetResolver {
  /** The OpenAI-compatible base (".../v1") to use now; null if none was ever found. */
  resolve(): Promise<string | null>;
  /** A call to this base failed or timed out: leave it behind and take the next one. */
  fail(base: string): void;
}

export function createFleetResolver(options: {
  hub: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}): FleetResolver {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(`[Vision] ${message}`));
  const hub = options.hub.replace(/\/+$/, '');
  let current: string | null = null;
  let resolvedAt = 0;
  // Bases that failed since the last refresh, skipped until then.
  const failed = new Set<string>();
  let resolving: Promise<string | null> | null = null;

  async function answers(base: string): Promise<boolean> {
    try {
      await doFetch(`${base}/healthz`, { signal: AbortSignal.timeout(LAN_PROBE_TIMEOUT_MS) });
      return true; // any HTTP reply: the box is reachable from here
    } catch {
      return false;
    }
  }

  async function baseOf(provider: FleetProvider): Promise<string | null> {
    for (const lan of provider.lanBases ?? []) {
      if (await answers(lan.replace(/\/+$/, ''))) return `${lan.replace(/\/+$/, '')}/v1`;
    }
    return provider.serverBase ? `${provider.serverBase.replace(/\/+$/, '')}/v1` : null;
  }

  async function lookUp(): Promise<string | null> {
    let providers: FleetProvider[];
    try {
      const response = await doFetch(`${hub}${PROVIDERS_PATH}`, { signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`hub answered ${response.status}`);
      providers = ((await response.json()) as { providers?: FleetProvider[] }).providers ?? [];
    } catch (error) {
      // Hub down: keep the last box that worked.
      log(`fleet hub ${hub} unreachable (${error instanceof Error ? error.message : String(error)}); keeping ${current ?? 'no provider'}`);
      return current;
    }
    resolvedAt = now();
    for (const provider of providers) {
      const base = await baseOf(provider);
      if (base && !failed.has(base)) {
        if (base !== current) log(`fleet:vision -> ${provider.id ?? '?'} at ${base}`);
        current = base;
        return current;
      }
    }
    if (providers.length > 0 && failed.size > 0) {
      // Every ranked box failed lately: start over from the top.
      failed.clear();
      const first = providers[0] ? await baseOf(providers[0]) : null;
      current = first ?? current;
      return current;
    }
    log('fleet hub lists no healthy vision provider');
    return current;
  }

  return {
    async resolve() {
      const stale = now() - resolvedAt >= FLEET_REFRESH_MS;
      if (current && !stale && !failed.has(current)) return current;
      if (stale) failed.clear();
      resolving ??= lookUp().finally(() => {
        resolving = null;
      });
      return resolving;
    },
    fail(base) {
      failed.add(base);
    },
  };
}
