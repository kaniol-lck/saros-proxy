/**
 * commandcode.ts — KeyProvider adapter for the CommandCode API
 * (api.commandcode.ai).
 *
 * Keys: `user_` tokens (definitive) and `sk-` console keys (ambiguous with
 * opencode-go → empirical smoke test required).
 *
 * Smoke test: GET /alpha/billing/subscriptions — cheap, read-only, no token
 * spend; 200 with planId = valid, 401 = invalid. Requests must carry
 * CLI-identity headers (the server gates on client version, verified live:
 * without them /alpha/generate returns 403 upgrade_required).
 */
import { MIN_KEY_LENGTH } from '../constants.js';
import type { KeyProvider, KeyUsage, PrefixMatch, SmokeResult } from './types.js';

export const COMMANDCODE_BASE_URL = 'https://api.commandcode.ai';
export const COMMANDCODE_BILLING_PATH = '/alpha/billing/subscriptions';

/** Latest CLI version, resolved lazily and cached for the process lifetime. */
let cachedClientVersion: string | null = null;

/** Resolve the current command-code CLI version from the npm registry. */
export async function resolveClientVersion(timeoutMs = 5_000): Promise<string> {
  if (cachedClientVersion) return cachedClientVersion;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://registry.npmjs.org/command-code/latest', {
      signal: controller.signal,
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)) {
        cachedClientVersion = body.version;
        return cachedClientVersion;
      }
    }
  } catch {
    // fall through to fallback
  } finally {
    clearTimeout(timer);
  }
  // Conservative floor: server rejects versions below 0.18.10 (verified live).
  return (cachedClientVersion = '0.18.10');
}

/** CLI-identity headers every authenticated CommandCode request needs. */
export function commandcodeClientHeaders(version: string): Record<string, string> {
  return {
    'User-Agent': `CommandCodeCLI/${version}`,
    'X-Command-Code-Version': version,
    'X-CLI-Environment': 'production',
    'X-Project-Slug': 'command-code',
    'X-CommandCode-Client': 'cli',
    'X-CommandCode-Client-Version': version,
    'X-CommandCode-CLI-Version': version,
    'X-Command-Code-Client-Version': version,
    'X-Command-Code-CLI-Version': version,
  };
}

interface SubscriptionBody {
  success?: boolean;
  data?: { planId?: unknown; status?: unknown };
  error?: { code?: unknown };
}

/** Extract planId from a billing/subscriptions response (opencommand-compatible). */
export function parsePlanId(body: string): string | undefined {
  let parsed: SubscriptionBody;
  try {
    parsed = JSON.parse(body) as SubscriptionBody;
  } catch {
    return undefined;
  }
  const planId = parsed?.data?.planId;
  return typeof planId === 'string' && planId.trim() ? planId.trim() : undefined;
}

/**
 * CommandCode has no per-key usage-percent API saros can query without
 * browser session cookies (verified: /v1/account/usage is not a registered
 * route on api.commandcode.ai). Usage-based weighted rotation is opencode-go
 * only; commandcode keys report no usage data.
 */
export const COMMANDCODE_PROVIDER_MODELS_PATH = '/provider/v1/models';

/** Bare-name index of the live catalog (last path segment of vendor ids). */
let catalogCache: { bareNames: Set<string>; nativeByBare: Map<string, string> } | null = null;
/** Ensures the background warm-up fires at most once per process. */
let warmupStarted = false;

function indexCatalog(models: Array<Record<string, unknown>>): void {
  const bareNames = new Set<string>();
  const nativeByBare = new Map<string, string>();
  for (const entry of models) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id) continue;
    bareNames.add(id.toLowerCase());
    const lastSegment = id.split('/').pop() ?? id;
    if (lastSegment) {
      bareNames.add(lastSegment.toLowerCase());
      if (!nativeByBare.has(lastSegment.toLowerCase())) {
        nativeByBare.set(lastSegment.toLowerCase(), id);
      }
    }
  }
  catalogCache = { bareNames, nativeByBare };
}

export const commandcodeProvider: KeyProvider = {
  id: 'commandcode',
  displayName: 'CommandCode',
  baseUrl: COMMANDCODE_BASE_URL,
  chatBasePath: '/provider/v1',

  quickMatch(key: string): PrefixMatch {
    if (key.startsWith('user_') && key.length >= MIN_KEY_LENGTH) return 'yes';
    // sk- shared with opencode-go → empirical test required
    return key.startsWith('sk-') && key.length >= MIN_KEY_LENGTH ? 'maybe' : 'no';
  },

  async smokeTest(key: string, timeoutMs = 10_000): Promise<SmokeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const version = await resolveClientVersion();
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${COMMANDCODE_BILLING_PATH}`, {
        headers: {
          ...commandcodeClientHeaders(version),
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
      });
      if (res.ok) {
        const planId = parsePlanId(await res.text());
        return {
          provider: this.id,
          status: 'valid',
          httpStatus: res.status,
          detail: planId ? `plan: ${planId}` : undefined,
          ...(planId ? { meta: { planId } } : {}),
        };
      }
      const definitive = res.status === 401 || res.status === 403;
      return {
        provider: this.id,
        status: definitive ? 'invalid' : 'error',
        httpStatus: res.status,
        detail: definitive ? 'upstream rejected the key' : 'upstream unavailable',
      };
    } catch (err) {
      return {
        provider: this.id,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  },

  usagePath(): string {
    return ''; // no queryable per-key usage API without a Studio session cookie
  },

  /**
   * [dsh-patch cc-usage] CommandCode 没有 per-key usage API，但计费端点能给出：
   *  - GET /alpha/billing/credits        → windowLimits.fiveHour/weekly {used,cap,resetAt} + credits.monthlyCredits
   *  - GET /alpha/billing/subscriptions  → planId / currentPeriodEnd（月度周期）
   * 用它们换算出 usedPercent（取三个窗口里最紧的一个），让加权轮询看得见 cc 的额度。
   */
  async queryUsage(apiKey: string, baseUrl: string, timeoutMs: number) {
    const headers = {
      ...(commandcodeProvider.extraUpstreamHeaders?.() ?? {}),
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    const getJSON = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch(new URL(path, baseUrl), { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const parsed: unknown = await res.json();
        return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const [credits, sub] = await Promise.all([
      getJSON('/alpha/billing/credits'),
      getJSON('/alpha/billing/subscriptions'),
    ]);
    if (!credits) return null;

    const num = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const obj = (value: unknown): Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const pct = (win: Record<string, unknown>): number | null => {
      const used = num(win.used);
      const cap = num(win.cap);
      if (used === null || cap === null || cap <= 0) return null;
      return Math.min(100, Math.max(0, Math.round((used / cap) * 1000) / 10));
    };
    const iso = (ms: number | null): string | undefined => (ms && ms > 0 ? new Date(ms).toISOString() : undefined);

    const wl = obj(credits.windowLimits);
    const five = obj(wl.fiveHour);
    const weekly = obj(wl.weekly);
    const balance = num(obj(credits.credits).monthlyCredits);
    const subData = obj(obj(sub).data);
    const planId = typeof subData.planId === 'string' ? subData.planId : null;

    // 月度 cap：优先套餐文档值，否则用 5h 上限 × 5 估算（GOAT: 14×5=70）
    const PLAN_MONTHLY_CREDITS: Record<string, number> = {
      'individual-go': 10, 'individual-goat': 70, 'individual-pro': 80,
      'individual-max': 100, 'individual-max-20x': 200,
    };
    const fiveCap = num(five.cap);
    const monthCap = planId && PLAN_MONTHLY_CREDITS[planId] != null
      ? PLAN_MONTHLY_CREDITS[planId]
      : (fiveCap && fiveCap > 0 ? fiveCap * 5 : null);
    const monthlyPct = monthCap && monthCap > 0 && balance !== null
      ? Math.min(100, Math.max(0, Math.round((Math.max(0, monthCap - balance) / monthCap) * 1000) / 10))
      : null;

    const values = [pct(five), pct(weekly), monthlyPct].filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    const periodEnd = typeof subData.currentPeriodEnd === 'string' ? Date.parse(subData.currentPeriodEnd) : null;
    return {
      usedPercent: Math.max(...values),
      rollingResetsAt: iso(num(five.resetAt)),
      weeklyResetsAt: iso(num(weekly.resetAt)),
      monthlyResetsAt: iso(periodEnd && Number.isFinite(periodEnd) ? periodEnd : null),
    };
  },

  parseUsageResponse(_body: string): KeyUsage | null {
    return null;
  },

  // Documented contract (commandcode.ai/docs/provider §Streaming): every
  // stream ends with a `usage` chunk, and stream_options.include_usage is the
  // documented way to request it. saros reads those counts for per-key
  // accounting — CommandCode exposes no quota API to poll.
  supportsStreamUsage: true,

  extraUpstreamHeaders() {
    return commandcodeClientHeaders(cachedClientVersion ?? '0.18.10');
  },

  /**
   * Live provider catalog. Verified live: this route is fully public
   * (200 with any or no Authorization header).
   */
  async fetchCatalog(timeoutMs = 5_000): Promise<Array<Record<string, unknown>> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `${COMMANDCODE_BASE_URL.replace(/\/$/, '')}${COMMANDCODE_PROVIDER_MODELS_PATH}`,
        { signal: controller.signal },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) return null;
      const models = (body.data.filter(
        (m): m is Record<string, unknown> =>
          typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).id === 'string',
      )).filter((m) => {
        // claude-* is served via the Anthropic Messages endpoint only
        // (verified live: chat/completions → unsupported_model). saros relays
        // chat/completions shapes, so these models are unusable through it.
        const id = typeof m.id === 'string' ? m.id : '';
        return !/^claude/i.test(id);
      });
      indexCatalog(models);
      return models;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Vendor-prefixed ids ('vendor/model') and Claude models are
   * commandcode-specific naming (opencode-go uses bare ids like 'glm-5').
   * Everything else is 'maybe' — catalogs overlap.
   */
  modelAffinity(modelId: string): 'yes' | 'no' | 'maybe' {
    if (modelId.includes('/')) return 'yes';
    if (/^claude/i.test(modelId)) return 'yes';
    return 'maybe';
  },

  /**
   * Bare-name affinity against the live catalog: 'deepseek-v4-flash' matches
   * the catalog entry 'deepseek/deepseek-v4-flash' (last path segment).
   * Cached after the first catalog fetch; 'no' until the catalog loads.
   */
  modelAffinityByName(bareName: string): 'yes' | 'no' | 'maybe' {
    if (catalogCache) {
      return catalogCache.bareNames.has(bareName.toLowerCase()) ? 'yes' : 'no';
    }
    // Warm the cache in the background (once per process).
    if (!warmupStarted) {
      warmupStarted = true;
      void commandcodeProvider.fetchCatalog?.();
    }
    // [dsh-patch cc-affinity-cold-start] 目录未加载时必须明确回答 'no'：
    // 此时 resolveNativeId 返回 null，targetModelId 不会把裸名改写成 cc 原生 id，
    // 选到 cc 就会把 'deepseek-v4.1-flash' 原样发过去，上游回
    // 400「Model ... is not supported on this endpoint」。等目录就绪再参与分流。
    return 'no';
  },

  /**
   * Bare name → commandcode's native id ('deepseek-v4-flash' →
   * 'deepseek/deepseek-v4-flash'). null when the catalog isn't loaded or
   * doesn't serve the name.
   */
  resolveNativeId(bareName: string): string | null {
    if (!catalogCache) return null;
    return catalogCache.nativeByBare.get(bareName.toLowerCase()) ?? null;
  },
};
