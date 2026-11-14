/**
 * workbuddy.ts — bridge provider for workbuddy2api (OpenAI-compatible gateway
 * running on the same NAS, http://192.168.10.2:7863).
 *
 * Key: the gateway's own `api_key` (43 chars). Model ids need a realm prefix
 * (`global:` / `cn:`) — resolveNativeId maps bare names onto the global realm
 * using the live catalog, cn fallback only when global does not serve it.
 *
 * Quota: the gateway has no per-key usage endpoint; /panel/api/usage
 * (Bearer api_key) reports per-account credits and /healthz the healthy
 * account count. usedPercent = 100 - creditScore(credits, total) is a rough
 * gauge: credits are a prepaid balance, not a rate window — the gateway's own
 * breaker handles soft-rate 429s internally.
 */
import type { KeyProvider, ModelAffinity, SmokeResult } from './types.js';
import type { KeyUsage } from './types.js';

const BASE_URL = 'http://192.168.10.2:7863';
const PANEL_USAGE_PATH = '/panel/api/usage';
const REALM = 'global'; // primary realm; cn served only when global misses

interface CatalogModel { id: string }

let catalogCache: { at: number; ids: string[] } | null = null;

async function catalogIds(timeoutMs: number): Promise<string[]> {
  if (catalogCache && Date.now() - catalogCache.at < 300_000) return catalogCache.ids;
  try {
    const r = await fetch(BASE_URL + '/v1/models', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return catalogCache?.ids ?? [];
    const j = (await r.json()) as { data?: CatalogModel[] };
    const ids = (j.data ?? []).map((m) => String(m.id));
    catalogCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return catalogCache?.ids ?? [];
  }
}

async function panelJson(path: string, apiKey: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(BASE_URL + path, {
      headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const workbuddyProvider: KeyProvider = {
  id: 'workbuddy',
  displayName: 'WorkBuddy (gateway)',
  baseUrl: BASE_URL,
  // wb2api serves the OpenAI standard: /v1/chat/completions (+ /v1/models)
  chatBasePath: '/v1',

  quickMatch(key: string) {
    // 生产 key 是裸 api_key（无结构前缀），必须靠 config.yaml 的
    // provider: workbuddy 显式声明路由 —— 这里只能返回 no，
    // 否则 isPlausibleKey 会对任意字符串放行，破坏 junk 过滤。
    return key.startsWith('wbk_') ? 'yes' : 'no';
  },

  async smokeTest(key: string, timeoutMs = 15000): Promise<SmokeResult> {
    try {
      const r = await fetch(BASE_URL + '/v1/models', {
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return { provider: this.id, status: 'valid', httpStatus: r.status };
      if (r.status === 401 || r.status === 403) return { provider: this.id, status: 'invalid', httpStatus: r.status };
      return { provider: this.id, status: 'error', httpStatus: r.status };
    } catch (err) {
      return { provider: this.id, status: 'error', detail: String((err as Error).message).slice(0, 120) };
    }
  },

  usagePath(): string {
    return ''; // no per-key usage endpoint; queryUsage below uses the panel API
  },

  async queryUsage(apiKey: string, _baseUrl: string, timeoutMs: number) {
    const usage = await panelJson(PANEL_USAGE_PATH, apiKey, timeoutMs);
    const byAccount = (usage?.credit_by_account ?? []) as Array<Record<string, unknown>>;
    const credits = byAccount.reduce((s, a) => s + Number(a.credits ?? 0), 0);
    // Rough gauge: treat 5000 credits as "full". Balance is prepaid, not a
    // window — this percentage is informational; the gateway's own breaker
    // handles soft-rate windows, so no resets are reported.
    const usedPercent = Math.max(0, Math.min(100, Math.round(100 - (credits / 5000) * 100)));
    return {
      usedPercent,
    } as KeyUsage;
  },

  parseUsageResponse(_body: string): KeyUsage | null {
    return null;
  },

  supportsStreamUsage: false,

  extraUpstreamHeaders(): Record<string, string> {
    return {};
  },

  async fetchCatalog(timeoutMs = 15000) {
    const ids = await catalogIds(timeoutMs);
    return ids.map((id) => ({ id }));
  },

  modelAffinity(modelId: string): ModelAffinity {
    if (modelId.startsWith('global:') || modelId.startsWith('cn:')) return 'yes';
    // bare names: 'maybe' — resolveNativeId decides with the live catalog
    return 'maybe';
  },

  modelAffinityByName(bareName: string): ModelAffinity {
    return this.modelAffinity(bareName);
  },

  resolveNativeId(bareName: string): string | null {
    const ids = catalogCache?.ids ?? [];
    if (ids.length === 0) return null; // cold start: fetchCatalog warms it up
    const g = REALM + ':' + bareName;
    if (ids.includes(g)) return g;
    const c = 'cn:' + bareName;
    if (ids.includes(c)) return c;
    // prefix match on bare name (e.g. 'deepseek-v4.1' → 'global:deepseek-v4.1-flash')
    const gHit = ids.find((id) => id.startsWith(REALM + ':') && id.slice(REALM.length + 1).startsWith(bareName));
    return gHit ?? null;
  },
};
