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

/**
 * [dsh-patch wb2api-catalog] wb2api 的 /v1/models 需要鉴权，而 KeyProvider
 * 的 fetchCatalog() 签名不带 key。这里记住首次见到的 api_key
 * （smokeTest / queryUsage 都会拿到），供 catalogIds() 使用。
 */
let apiKeyCache: string | null = null;

/**
 * [dsh-patch wb2api-catalog] 由 proxy 在成功用 key 拉到目录后回调，
 * 直接灌入本地缓存 —— 不再依赖 queryUsage 的调用时机（本部署的额度采集
 * 走独立进程，主进程收不到 key）。
 */
export function primeWorkbuddyCatalog(ids: string[]): void {
  if (!ids || ids.length === 0) return;
  catalogCache = { at: Date.now(), ids };
}

/** 记住 api_key，供后续带鉴权的目录拉取使用。 */
export function rememberWorkbuddyKey(key: string): void {
  if (key) apiKeyCache = key;
}

async function catalogIds(timeoutMs: number): Promise<string[]> {
  if (catalogCache && Date.now() - catalogCache.at < 300_000) return catalogCache.ids;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKeyCache) headers.authorization = 'Bearer ' + apiKeyCache;
    const r = await fetch(BASE_URL + '/v1/models', { headers, signal: AbortSignal.timeout(timeoutMs) });
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
      if (r.ok) {
        apiKeyCache = key;
        return { provider: this.id, status: 'valid', httpStatus: r.status };
      }
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
    if (apiKey) apiKeyCache = apiKey;
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
    const ids = catalogCache?.ids ?? [];
    // 目录还没加载：不否决（'maybe'），交给 resolveNativeId 在请求路径上判
    if (ids.length === 0) return 'maybe';
    const bare = modelId.toLowerCase();
    const hit = ids.some((id) => {
      const i = id.toLowerCase();
      return i === 'global:' + bare || i === 'cn:' + bare;
    });
    return hit ? 'yes' : 'no';
  },

  modelAffinityByName(bareName: string): ModelAffinity {
    return this.modelAffinity(bareName);
  },

  resolveNativeId(bareName: string): string | null {
    const ids = catalogCache?.ids ?? [];
    if (ids.length === 0) return null; // callers fall back to warm via fetchCatalog
    const bare = bareName.toLowerCase();
    // 1) global 精确 → 2) cn 精确 —— 两边都有的模型优先 global
    //    （cn 账号服务不了 deepseek 系，先试 cn 会白白 503 一次）
    const g = REALM + ':' + bare;
    const exactG = ids.find((id) => id.toLowerCase() === g);
    if (exactG) return exactG;
    const c = 'cn:' + bare;
    const exactC = ids.find((id) => id.toLowerCase() === c);
    if (exactC) return exactC;
    // 3) global 前缀 → 4) cn 前缀（例如 hy4 → global:hy4-preview / cn:hy4std）
    const prefixOf = (realm: string): string | undefined =>
      ids.find((id) => {
        const low = id.toLowerCase();
        return low.startsWith(realm + ':') && low.slice(realm.length + 1).startsWith(bare);
      });
    return prefixOf('global') ?? prefixOf('cn') ?? null;
  },
};
