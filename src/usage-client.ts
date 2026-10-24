/**
 * usage-client.ts — Per-key quota usage from the upstream usage API.
 *
 * GET <upstream>/zen/go/v1/usage (Bearer = the proxy's own API key) returns:
 *   {"usage":{"rolling":{"status":"ok","percent":12,"resetsAt":"…"},
 *             "weekly":{…},"monthly":{…}}}
 *
 * Refresh strategy: stale-while-revalidate on demand. `maybeRefreshUsage`
 * is called on the request path; when data is older than USAGE_REFRESH_TTL_MS
 * and no refresh is in flight, it fires a background refresh for every key.
 * Failures keep the last known values (weighted rotation just keeps working
 * with slightly stale percentages).
 */

import { logger } from './logger.js';
import { USAGE_FETCH_TIMEOUT_MS, USAGE_PATH, USAGE_REFRESH_TTL_MS } from './constants.js';
import { updateKeyUsage, setKeyEntitlement, type ProxyState } from './proxy-logic.js';
import type { ProxyConfig } from './config.js';
import { getProvider, inferProvider } from './providers/index.js';
import type { ProviderId } from './providers/index.js';

export interface KeyUsage {
  /** Worst-window used percent, 0-100. */
  usedPercent: number;
  rollingPercent: number;
  weeklyPercent: number;
  monthlyPercent: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
}

/** Outcome of one usage fetch. */
export interface UsageFetchResult {
  /** Parsed usage, or null when the fetch failed / violated the contract. */
  usage: KeyUsage | null;
  /**
   * The upstream rejected the key for lack of plan (403 EntitlementError /
   * upgrade_required). Definitive, not transient: the account cannot use this
   * provider's models at all, so rotation drops the key until a later
   * refresh shows it usable again.
   */
  noEntitlement: boolean;
}

/**
 * 403 bodies that mean "this account has no plan for this provider":
 * opencode-go → `{"error":{"type":"EntitlementError","message":"OpenCode Go
 * subscription required."}}`, commandcode → `403 upgrade_required`.
 * Plan-gated *models* (opencode-go's 403 `MODEL_NOT_IN_PLAN`) are a request
 * problem, not an account one, and must not match.
 */
export function isEntitlementError(status: number, body: string): boolean {
  return status === 403 && /subscription|entitlement|upgrade_required/i.test(body);
}

interface UsageWindow {
  status?: string;
  percent?: unknown;
  resetsAt?: string;
}

interface UsageResponse {
  usage?: Partial<Record<'rolling' | 'weekly' | 'monthly', UsageWindow>>;
}

function parsePercent(window: UsageWindow | undefined): number {
  const percent = window?.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** Parse a usage API response body into KeyUsage (throws on contract violation). */
export function parseUsageResponse(body: string): KeyUsage {
  let parsed: UsageResponse;
  try {
    parsed = JSON.parse(body) as UsageResponse;
  } catch {
    throw new Error('usage response is not valid JSON');
  }
  const usage = parsed?.usage;
  if (!usage || typeof usage !== 'object') {
    throw new Error('usage response missing "usage" object');
  }
  const rolling = parsePercent(usage.rolling);
  const weekly = parsePercent(usage.weekly);
  const monthly = parsePercent(usage.monthly);
  return {
    rollingPercent: rolling,
    weeklyPercent: weekly,
    monthlyPercent: monthly,
    usedPercent: Math.max(rolling, weekly, monthly),
    rollingResetsAt: typeof usage.rolling?.resetsAt === 'string' ? usage.rolling.resetsAt : undefined,
    weeklyResetsAt: typeof usage.weekly?.resetsAt === 'string' ? usage.weekly.resetsAt : undefined,
    monthlyResetsAt: typeof usage.monthly?.resetsAt === 'string' ? usage.monthly.resetsAt : undefined,
  };
}

/**
 * Fetch current usage for one key. Failures (network, timeout, non-200,
 * contract violation) yield `usage: null` — callers treat that as "no fresh
 * data". A 403 entitlement rejection is reported separately because it is
 * definitive rather than transient.
 */
export async function fetchKeyUsage(
  upstreamBaseUrl: string,
  apiKey: string,
  usagePath: string = USAGE_PATH,
): Promise<UsageFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(usagePath, upstreamBaseUrl), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    // Keep the abort armed through the body read: a stalled body after a 200
    // must still time out, or refreshInFlight stays true forever and usage
    // rotation freezes on stale percentages.
    const body = await response.text();
    if (!response.ok) {
      return { usage: null, noEntitlement: isEntitlementError(response.status, body) };
    }
    try {
      return { usage: parseUsageResponse(body), noEntitlement: false };
    } catch {
      return { usage: null, noEntitlement: false };
    }
  } catch {
    return { usage: null, noEntitlement: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate coordinator (one per proxy process)
// ---------------------------------------------------------------------------

let lastRefreshAt = 0;
let refreshInFlight = false;

/** Test seam: reset coordinator state. */
export function resetUsageRefreshState(): void {
  lastRefreshAt = 0;
  refreshInFlight = false;
}

/**
 * Kick off a background refresh of every key's usage when the cached data is
 * older than USAGE_REFRESH_TTL_MS. Fire-and-forget: never throws, never blocks
 * the request path, deduplicates concurrent calls.
 */
export function maybeRefreshUsage(state: ProxyState, config: ProxyConfig): void {
  const now = Date.now();
  if (refreshInFlight || now - lastRefreshAt < USAGE_REFRESH_TTL_MS) return;

  refreshInFlight = true;
  lastRefreshAt = now;

  void (async () => {
    try {
      const entries = await Promise.all(
        state.keys.map(async (k) => {
          const provider = getProvider(inferProvider({ label: k.label, key: k.key, provider: k.provider as ProviderId | undefined }));
          // Providers without a queryable usage API (commandcode) are skipped —
          // weighted rotation simply treats them as having no fresh data.
          if (!provider || !provider.usagePath()) return [k.label, null] as const;
          const base = config.upstreams?.[provider.id] ?? (provider.id === 'opencode-go' ? config.upstreamBaseUrl : provider.baseUrl);
          const usage = await fetchKeyUsage(base, k.key, provider.usagePath());
          return [k.label, usage] as const;
        }),
      );
      const percents = new Map<string, number>();
      for (const [label, result] of entries) {
        if (!result) continue;
        if (result.usage) {
          percents.set(label, result.usage.usedPercent);
          // A key that answers the usage API is entitled again.
          setKeyEntitlement(state, label, true);
        } else if (result.noEntitlement) {
          setKeyEntitlement(state, label, false);
        }
        // Transient failures leave the previous entitlement untouched.
      }
      if (percents.size > 0) {
        updateKeyUsage(state, percents);
        logger.debug({ keys: [...percents.keys()] }, 'key usage refreshed');
      }
    } catch (err) {
      logger.debug({ err }, 'usage refresh failed');
    } finally {
      refreshInFlight = false;
    }
  })();
}
