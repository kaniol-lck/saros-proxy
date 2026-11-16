/**
 * proxy-logic.ts — Pure production logic. Saros picks the best key per request.
 *
 * No I/O, no console.log, no HTTP — completely portable and testable.
 *
 * Critical fixes over prototype:
 *   C1. Circuit breaker cooldown (lazy auto-re-enable via disabledAt)
 *   C2. Error classification (KeyFault | RequestFault | ServerFault)
 *   C3. Read-only KeySnapshot returned instead of mutable ApiKey reference
 *   C4. Request-scoped key tracking (activeRequests map)
 */

import { DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS } from './constants.js';

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

interface ApiKey {
  label: string;
  key: string;
  /** Provider id ('opencode-go' | 'commandcode' | future extensions). */
  provider: string;
  enabled: boolean;
  consecutiveFailures: number;
  lastUsed: number | null;
  disabledAt: number | null; // C1: timestamp when key was disabled for cooldown
  /** Worst-window used percent (0-100) reported by the upstream usage API. */
  usagePercent: number | null;
  /**
   * False when the upstream rejected this key for lack of plan
   * (403 EntitlementError / upgrade_required): the account cannot use the
   * provider's models at all, so the key leaves rotation until the usage
   * refresh sees it work again. Independent of the circuit breaker — this is
   * not a transient fault.
   */
  entitled: boolean;
  /**
   * [dsh-patch quota-out] 月度/周期额度撞顶后，禁用到上游声明的重置时刻。
   * 与熔断不同：这不是瞬态故障，60s 冷却只会造成"复活→立刻 429→再熔断"的循环。
   */
  quotaOutUntil: number | null;
  /** Smooth weighted round-robin state (nginx-style). */
  currentWeight: number;
}

/** Read-only projection returned to callers — cannot mutate internal state. */
export interface KeySnapshot {
  label: string;
  key: string;
  /** Provider this key belongs to (set at state creation from config). */
  provider: string;
}

/** Tracks a single HTTP request's key usage through its lifecycle. */
interface RequestContext {
  requestId: string;
  triedKeys: string[]; // keys already attempted for this request (for failover)
  /** [dsh-patch stale-sweep] 上下文创建时刻，用于清扫僵尸请求。 */
  createdAt?: number;
  currentKey: KeySnapshot | null; // the key currently in use by this request
  /**
   * Provider filter fixed at selection time (model affinity / @suffix pin).
   * Failover re-applies it so a pinned commandcode request never fails over
   * to an opencode-go key that cannot serve the (already rewritten) model id.
   */
  providerFilter?: (provider: string) => boolean;
  /** True when the model is provider-pinned (@suffix) — tier-3 cross-provider fallback disabled. */
  pinned?: boolean;
}

export interface ProxyState {
  keys: ApiKey[];
  currentIndex: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  activeRequests: Map<string, RequestContext>; // C4
  /**
   * Optional model→provider affinity resolver: (providerId, modelId) →
   * 'yes' | 'no' | 'maybe'. Wired from the provider registry at app setup;
   * absence disables affinity routing (single-provider behavior).
   */
  affinityResolver?: (provider: string, modelId: string) => 'yes' | 'no' | 'maybe';
}

/**
 * Error classification for HTTP responses.
 * - KeyFault: the API key should be penalised (invalid, revoked, quota exhausted)
 * - RequestFault: the request itself is bad — no key penalisation
 * - ServerFault: transient server issue — key penalised (normal circuit-breaker)
 * - NetworkFault: timeout / connection error — no key penalisation. The
 *   upstream base URL is shared by every key, so network-level failures are
 *   not a per-key fault; disabling keys for them caused total-blackout
 *   lockups ("all keys unavailable") when the upstream hung. Failover still
 *   tries the next key for this request.
 */
export type ErrorType =
  | 'KeyFault'
  | 'ServerFault'
  | 'RequestFault'
  | 'NetworkFault'
  | 'QuotaExhausted'
  /** [dsh-patch model-affinity] 这家 provider 服务不了这个模型（换一家即可，key 本身没问题）。 */
  | 'ModelUnavailable';

// ---------------------------------------------------------------------------
// State Factory
// ---------------------------------------------------------------------------

export function createProxyState(
  keys: Array<{ label: string; key: string; provider?: string }>,
  options?: {
    circuitBreakerThreshold?: number;
    circuitBreakerCooldownMs?: number;
  },
): ProxyState {
  return {
    keys: keys.map((k) => ({
      label: k.label,
      key: k.key,
      provider: k.provider ?? 'opencode-go',
      enabled: true,
      consecutiveFailures: 0,
      lastUsed: null,
      disabledAt: null,
      usagePercent: null,
      entitled: true,
  quotaOutUntil: null,
      currentWeight: 0,
    })),
    currentIndex: 0,
    circuitBreakerThreshold: options?.circuitBreakerThreshold ?? 3,
    circuitBreakerCooldownMs: options?.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    activeRequests: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Internal: return a read-only snapshot of the key already selected.
 * (Keeps mutation paths through markKeyFailed / markKeySucceeded.)
 */
function toSnapshot(key: ApiKey): KeySnapshot {
  return { label: key.label, key: key.key, provider: key.provider };
}

/**
 * Internal: check whether a key is available (enabled & under threshold).
 * If the key is disabled but past its cooldown window, it is lazily re-enabled
 * (C1 — fixes dead-code cooldown).
 */
function isKeyAvailable(state: ProxyState, key: ApiKey): boolean {
  // Entitlement is definitive, not transient: a key whose account has no
  // plan for this provider must not be retried until the usage refresh
  // clears the flag.
  if (!key.entitled) return false;

  // [dsh-patch quota-out] 额度撞顶禁用到重置时刻；到期自动回到轮询（无 lazy 状态残留）。
  if (key.quotaOutUntil !== null) {
    if (Date.now() < key.quotaOutUntil) return false;
    key.quotaOutUntil = null;
  }

  if (key.enabled && key.consecutiveFailures < state.circuitBreakerThreshold) {
    return true;
  }

  // C1: lazy auto-re-enable after cooldown expires
  if (!key.enabled && key.disabledAt !== null) {
    const elapsed = Date.now() - key.disabledAt;
    if (elapsed >= state.circuitBreakerCooldownMs) {
      key.enabled = true;
      key.consecutiveFailures = 0;
      key.disabledAt = null;
      return true;
    }
  }

  return false;
}

/**
 * Internal: return the set of key labels that are currently *in use* by
 * active requests (C4 double-booking avoidance).
 *
 * Previously this collected ALL ctx.triedKeys, which meant an abandoned key
 * (one a request failed over from) stayed globally excluded even though
 * nobody was using it.  Now it only tracks the key each request is actively
 * using (ctx.currentKey).  Tried keys are still excluded per-request via
 * the per-request excludeLabels in selectKeyForRequest/failoverRequest.
 */
function buildBookedLabels(state: ProxyState): Set<string> {
  const booked = new Set<string>();
  for (const [, ctx] of state.activeRequests) {
    if (ctx.currentKey) {
      booked.add(ctx.currentKey.label);
    }
  }
  return booked;
}

/**
 * Internal: find the next available key, skipping:
 *  - disabled / under-cooldown keys
 *  - labels in `excludeLabels`
 *
 * Selection strategy (smooth weighted round-robin, nginx-style):
 *  - When usage data is known for the candidates, keys with more remaining
 *    quota are proportionally preferred. E.g. key X at 30% used and key Y at
 *    70% used receive ~70%/30% of requests — exact proportions over a cycle,
 *    not random sampling.
 *  - Without usage data (or when every candidate is exhausted), falls back to
 *    plain round-robin ordering.
 */
/**
 * [dsh-patch hedge] 列出可用于"对冲"的备选 key（不改变加权状态、不消耗 triedKeys）：
 * 只返回未被本请求试过、当前可用、且通过 provider 过滤的 key。
 * 调用方（proxy.ts）还会再用 providerCanServe 过滤一次。
 */
export function peekAlternativeKeys(
  state: ProxyState,
  requestId: string,
  excludeLabel: string,
): KeySnapshot[] {
  const ctx = state.activeRequests.get(requestId);
  const tried = new Set<string>(ctx?.triedKeys ?? []);
  tried.add(excludeLabel);
  // 只在"模型被 provider 钉死"时才套用 providerFilter；否则把过滤权交给调用方的
  // providerCanServe（它会按"该 provider 能否服务此 model"判定，允许跨 provider 对冲）。
  const filter = ctx?.pinned ? ctx?.providerFilter : undefined;
  const out: KeySnapshot[] = [];
  for (const key of state.keys) {
    if (tried.has(key.label)) continue;
    if (!isKeyAvailable(state, key)) continue;
    if (filter && !filter(key.provider)) continue;
    out.push(toSnapshot(key));
  }
  return out;
}

function findNextKey(
  state: ProxyState,
  excludeLabels: Set<string>,
  providerFilter?: (provider: string) => boolean,
): KeySnapshot | null {
  const n = state.keys.length;
  if (n === 0) return null;

  const candidates: ApiKey[] = [];
  for (let i = 0; i < n; i++) {
    const key = state.keys[(state.currentIndex + i) % n];
    if (excludeLabels.has(key.label)) continue;
    if (providerFilter && !providerFilter(key.provider)) continue;
    if (!isKeyAvailable(state, key)) continue;
    candidates.push(key);
  }
  if (candidates.length === 0) return null;

  const picked = pickWeighted(state, candidates);
  state.currentIndex = (state.keys.indexOf(picked) + 1) % n;
  picked.lastUsed = Date.now();
  return toSnapshot(picked);
}

/**
 * Internal: smooth weighted round-robin over the candidates.
 * Falls back to the first candidate (round-robin order) when usage data is
 * missing for any candidate or when no candidate has remaining capacity.
 */
/**
 * [dsh-patch provider-weight-factor] 按 provider 质量系数缩放额度权重。
 * env: PROVIDER_WEIGHT_FACTOR="commandcode=0.55,opencode-go=1"
 * 保留跨 provider 分流与故障转移，只是让成功率低的 provider 少分流量。
 */
let providerWeightFactors: Record<string, number> | null = null;

function getProviderWeightFactors(): Record<string, number> {
  if (providerWeightFactors) return providerWeightFactors;
  const factors: Record<string, number> = {};
  for (const part of (process.env.PROVIDER_WEIGHT_FACTOR ?? '').split(',')) {
    const [id, raw] = part.split('=');
    const value = Number(raw);
    if (id && Number.isFinite(value) && value >= 0) factors[id.trim()] = value;
  }
  providerWeightFactors = factors;
  return factors;
}

function pickWeighted(state: ProxyState, candidates: ApiKey[]): ApiKey {
  const known = candidates.filter((k) => k.usagePercent !== null);
  if (known.length === 0) return candidates[0];

  let weights = candidates.map((k) => Math.max(0, 100 - (k.usagePercent ?? 0)));
  // Keys missing usage data get the median of the known weights — neutral,
  // so one flaky key no longer disables weighting for the whole pool.
  const sorted = known.map((k) => 100 - (k.usagePercent ?? 0)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  weights = weights.map((w, i) => (candidates[i].usagePercent === null ? median : w));
  // [dsh-patch provider-weight-factor] 质量系数（1 = 不调整）
  const factors = getProviderWeightFactors();
  if (Object.keys(factors).length > 0) {
    weights = weights.map((w, i) => {
      const factor = factors[candidates[i].provider];
      return factor === undefined ? w : Math.max(1, Math.round(w * factor));
    });
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return candidates[0];

  let best = candidates[0];
  let bestWeight = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].currentWeight += weights[i];
    if (candidates[i].currentWeight > bestWeight) {
      bestWeight = candidates[i].currentWeight;
      best = candidates[i];
    }
  }
  best.currentWeight -= totalWeight;
  return best;
}

/**
 * Update per-key usage data (worst-window used percent, 0-100).
 * Keys absent from the map keep their previous value.
 */
export function updateKeyUsage(state: ProxyState, usage: Map<string, number>): void {
  for (const key of state.keys) {
    const percent = usage.get(key.label);
    if (typeof percent === 'number') key.usagePercent = percent;
  }
}

/**
 * Mark a key as (not) entitled to use its provider. Unentitled keys are
 * skipped by selection without touching the circuit breaker; the usage
 * refresh flips the flag back as soon as the account can serve requests
 * again.
 */
/**
 * [dsh-patch quota-out] 把 key 禁用到指定时刻（月度额度重置）。
 * 不动熔断计数 —— 这是确定性禁用，到期由 isKeyAvailable 自动恢复。
 */
export function setKeyQuotaOut(state: ProxyState, keyLabel: string, untilMs: number): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;
  key.quotaOutUntil = Math.max(untilMs, Date.now() + 60_000);
  key.enabled = true;            // 避免熔断冷却先挡住
  key.consecutiveFailures = 0;   // 重置失败计数

}

export function setKeyEntitlement(state: ProxyState, keyLabel: string, entitled: boolean): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (key) key.entitled = entitled;
}

// ---------------------------------------------------------------------------
// Request-Scoped Key Tracking (C4)
// ---------------------------------------------------------------------------

/** Parse a trailing '@provider' suffix from a model id ('x@cc' → 'cc'). */
function parseModelSuffix(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const at = modelId.lastIndexOf('@');
  if (at <= 0 || at === modelId.length - 1) return null;
  return modelId.slice(at + 1);
}

/**
 * Resolve the provider-preference predicate for a request.
 *
 * Rule: exclude providers whose verdict is definitively 'no' for the model
 * (e.g. claude-* on opencode-go). Everything else — 'yes' AND 'maybe' —
 * serves the request, so genuinely shared models rotate across ALL their
 * keys regardless of which catalog loaded first. When no provider says 'no'
 * the filter is undefined (legacy any-key behavior).
 */
function makeProviderFilter(
  state: ProxyState,
  modelId?: string,
): ((provider: string) => boolean) | undefined {
  if (!modelId) return undefined;
  const resolver = state.affinityResolver;
  if (!resolver) return undefined;
  const excluded = new Set<string>();
  for (const key of state.keys) {
    if (excluded.has(key.provider)) continue;
    if (resolver(key.provider, modelId) === 'no') {
      excluded.add(key.provider);
    }
  }
  if (excluded.size === 0) return undefined;
  return (provider) => !excluded.has(provider);
}

/**
 * Obtain a key for a new (or in-flight) request.
 * Creates a RequestContext if one does not already exist for this requestId.
 * Skips keys that have already been tried for this request AND keys booked
 * by any other active request.
 *
 * When a modelId is supplied and some providers claim it (modelAffinity
 * 'yes'), keys of other providers are only used after the preferred pool is
 * exhausted (including its booked-share tier).
 */
export function selectKeyForRequest(
  state: ProxyState,
  requestId: string,
  modelId?: string,
  /**
   * [dsh-patch big-body-prefer-local] 指定优先 provider（如 'workbuddy'）。
   * 大 body 走本地网关更稳：实测 cc 对 1.1MB 直接 UND_ERR_SOCKET，wb2api 200。
   * 该 provider 没有可用 key 时，自动落回原有分档逻辑。
   */
  preferProvider?: string,
): KeySnapshot | null {
  // If context already exists, return the already-assigned current key
  const existing = state.activeRequests.get(requestId);
  if (existing) {
    return existing.currentKey;
  }

  // Create new context and pick a fresh key
  sweepStaleRequests(state);
  const ctx: RequestContext = { requestId, triedKeys: [], currentKey: null, createdAt: Date.now() };
  state.activeRequests.set(requestId, ctx);

  const providerFilter = makeProviderFilter(state, modelId);
  ctx.providerFilter = providerFilter;
  ctx.pinned = Boolean(parseModelSuffix(modelId));

  // Tier 1: prefer a key not booked by another active request (spread load)
  const excludeLabels = new Set(ctx.triedKeys);
  const booked = buildBookedLabels(state);
  for (const label of booked) {
    excludeLabels.add(label);
  }

  // [dsh-patch big-body-prefer-local] 先试指定 provider（大 body 优先本地网关）
  if (preferProvider) {
    const preferFilter = (p: string): boolean => p === preferProvider;
    let preferred = findNextKey(state, excludeLabels, preferFilter);
    if (!preferred) preferred = findNextKey(state, new Set(ctx.triedKeys), preferFilter);
    if (preferred) {
      ctx.currentKey = preferred;
      return preferred;
    }
  }

  let snapshot = findNextKey(state, excludeLabels, providerFilter);

  // Tier 2: all healthy preferred keys are booked — share one via
  // round-robin. Better to share a key than return 503 when concurrent
  // requests outnumber the key pool.
  if (!snapshot) {
    snapshot = findNextKey(state, new Set(ctx.triedKeys), providerFilter);
  }

  // Tier 3: preferred providers exhausted → fall back to any provider
  // (pinned requests exempt: a @provider suffix or messages-only model
  // cannot be served by other providers at all).
  if (!snapshot && providerFilter && !ctx.pinned) {
    snapshot = findNextKey(state, new Set(ctx.triedKeys));
  }

  ctx.currentKey = snapshot;
  return snapshot;
}

/**
 * [dsh-patch stale-sweep] 清掉超龄的请求上下文。
 *
 * 只要有一次没走到 completeRequest（例如卡在等上游响应头），
 * activeRequests 就会永久 +1，并且那把 key 一直被 buildBookedLabels 当成"占用"。
 * 实测堆到 17 个，直接把选点逼进"共享 key"档位。这里在每次选点时顺手清理。
 */
export function sweepStaleRequests(state: ProxyState, maxAgeMs?: number): number {
  const limit = maxAgeMs ?? (Number(process.env.STALE_REQUEST_MAX_AGE_MS ?? 0) || 600_000);
  const now = Date.now();
  let removed = 0;
  for (const [rid, ctx] of state.activeRequests) {
    const born = ctx.createdAt ?? 0;
    if (born > 0 && now - born > limit) {
      state.activeRequests.delete(rid);
      removed++;
    }
  }
  return removed;
}

/**
 * [dsh-patch session-sticky] 按 label 精确取一把 key（会话粘性用）。
 *
 * 与 selectKeyForRequest 的区别：不参与加权轮转，直接锁定指定 key。
 * key 不可用时返回 null，并且**不**建立请求上下文（否则 selectKeyForRequest
 * 会因为 ctx 已存在而返回 null）。
 */
export function selectKeyByLabel(
  state: ProxyState,
  requestId: string,
  label: string,
): KeySnapshot | null {
  const existing = state.activeRequests.get(requestId);
  if (existing) return existing.currentKey;

  const key = state.keys.find((k) => k.label === label);
  if (!key || !isKeyAvailable(state, key)) return null;

  const snapshot = toSnapshot(key);
  const ctx: RequestContext = { requestId, triedKeys: [], currentKey: snapshot, createdAt: Date.now() };
  state.activeRequests.set(requestId, ctx);
  return snapshot;
}

/**
 * Failover: record the current key of this request as failed and pick the next
 * available key.  The caller should also call markKeyFailed() with the
 * appropriate ErrorType; this function only manages the request-context
 * tracking (adds the current key to triedKeys).
 */
export function failoverRequest(
  state: ProxyState,
  requestId: string,
): KeySnapshot | null {
  const ctx = state.activeRequests.get(requestId);
  if (!ctx) return null;

  // Record current key as tried
  if (ctx.currentKey) {
    ctx.triedKeys.push(ctx.currentKey.label);
  }

  // The provider preference was fixed when the request context was created;
  // failover re-applies it so cross-provider failover can't pick a key that
  // cannot serve the (possibly rewritten) model id.
  const filter = ctx.providerFilter;
  const excludeLabels = new Set(ctx.triedKeys);
  const booked = buildBookedLabels(state);
  for (const label of booked) {
    excludeLabels.add(label);
  }

  let snapshot = findNextKey(state, excludeLabels, filter);

  // Tier 2: all remaining healthy preferred keys are booked — share one.
  // Still respects per-request triedKeys (don't re-use a key this
  // request already failed on).
  if (!snapshot) {
    snapshot = findNextKey(state, new Set(ctx.triedKeys), filter);
  }

  // Tier 3: exhausted → any provider, unless the model is provider-pinned.
  if (!snapshot && !ctx.pinned) {
    snapshot = findNextKey(state, new Set(ctx.triedKeys));
  }

  ctx.currentKey = snapshot;
  return snapshot;
}

/**
 * Complete a request: if successful, mark the current key as succeeded;
 * always clean up the request context.
 */
export function completeRequest(
  state: ProxyState,
  requestId: string,
  success: boolean,
): void {
  const ctx = state.activeRequests.get(requestId);
  if (!ctx) return;

  if (success && ctx.currentKey) {
    markKeySucceeded(state, ctx.currentKey.label);
  }

  state.activeRequests.delete(requestId);
}

// ---------------------------------------------------------------------------
// Key Status Mutations
// ---------------------------------------------------------------------------

/**
 * Mark a key as failed according to the error type (C2).
 * - KeyFault / ServerFault: penalise the key (KeyFault disables immediately)
 * - RequestFault / NetworkFault: no penalisation (bad request, or network
 *   trouble that is not the key's fault)
 */
export function markKeyFailed(
  state: ProxyState,
  keyLabel: string,
  errorType: ErrorType,
): void {
  if (errorType === 'RequestFault' || errorType === 'NetworkFault') return;
  if (errorType === 'QuotaExhausted') {
    // 由调用方先解析重置时间并调 setKeyQuotaOut；这里只是兜底（1 小时后重试）。
    // 纯逻辑模块不打日志，观察由 proxy.ts 侧负责。
    setKeyQuotaOut(state, keyLabel, Date.now() + 3600_000);
    return;
  }

  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;

  if (errorType === 'KeyFault') {
    // Disable immediately — the key is compromised / rate-limited
    key.consecutiveFailures = state.circuitBreakerThreshold;
    key.enabled = false;
    key.disabledAt = Date.now(); // C1: start cooldown timer
  } else {
    // ServerFault: normal circuit-breaker increment
    key.consecutiveFailures++;
    if (key.consecutiveFailures >= state.circuitBreakerThreshold) {
      key.enabled = false;
      key.disabledAt = Date.now(); // C1: start cooldown timer
    }
  }
}

/**
 * Mark a key as succeeded — resets consecutive failures.
 */
export function markKeySucceeded(state: ProxyState, keyLabel: string): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;
  key.consecutiveFailures = 0;
  // C1: clear cooldown on success so next selection isn't penalised
  key.disabledAt = null;
}

// ---------------------------------------------------------------------------
// Status Queries
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error Classification (C2)
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP error status + optional response body into an ErrorType.
 *
 * Rules:
 *  401               → KeyFault  (invalid/revoked key — immediate disable)
 *  429               → ServerFault (transient rate-limit — incremental circuit breaker)
 *  500 / 502 / 503   → KeyFault if body mentions quota/balance, else ServerFault
 *  400 / 403 / 404 / 422 → RequestFault (bad request or permission denial —
 *                      don't penalise the key; 403 MODEL_NOT_IN_PLAN is a plan
 *                      restriction, found live on commandcode)
 *  everything else   → ServerFault
 */
export function classifyHttpError(status: number, _body?: string): ErrorType {
  if (status === 401) {
    // opencode-go returns 401 ModelError for UNKNOWN MODELS (verified live:
    // a Model gpt-5.5 is not supported, with a valid key). That is a request
    // fault — penalising it would disable every key as the pool rotates.
    if (_body && /ModelError|not supported/i.test(_body)) return 'RequestFault';
    return 'KeyFault';
  }
  if (status === 429) {
    // [dsh-patch quota-out] 429 且 body 是额度耗尽（带 resets / UsageLimitError）
    // → 不是瞬态限流，禁用到重置时刻，避免 60s 冷却循环。
    if (_body && /UsageLimitError|usage limit reached|resets in/i.test(_body)) return 'QuotaExhausted';
    return 'ServerFault';
  }
  // [dsh-patch wb2api-bridge] wb2api 的 per-model cooldown 400 语义是"这台网关
  // 暂时服务不了该模型"——换 provider（cc/oc）可能成功，必须 failover，
  // 不能像普通 400 那样透传给客户端。
  if (status === 400 && _body && /per-model cooldown/i.test(_body)) return 'ServerFault';
  // [dsh-patch model-affinity] "这家服务不了这个模型" ≠ 客户端请求有错。
  // 换一个 provider 往往就能成（wb2api 有全套模型），所以归为 ModelUnavailable：
  // 触发 failover，但不惩罚 key。否则 403 会原样透传给客户端，
  // DSH 再把它显示成「API 密钥无效」（已实测踩过）。
  if (status === 403 && _body && /MODEL_NOT_IN_PLAN/i.test(_body)) return 'ModelUnavailable';
  if (status === 400 && _body && /is not supported on this endpoint/i.test(_body)) return 'ModelUnavailable';
  // [dsh-patch model-affinity] wb2api 的 503 no_healthy_account 是"该模型在它账号池里
  // 全在冷却"，属模型级不可用；若当 ServerFault 会连击 3 次把整把 key 关掉，
  // 之后所有 wb2api 模型都 503（实测一次 sweep 后半段整片失败）。
  if ((status === 400 || status === 503)
      && _body && /model_unavailable|model_blocked|no_healthy_account/i.test(_body)) {
    return 'ModelUnavailable';
  }
  if (status === 400 || status === 403 || status === 404 || status === 422) return 'RequestFault';
  if (status === 500 || status === 502 || status === 503) {
    // Server errors: if the body hints at a quota/balance issue treat as KeyFault
    if (_body && /quota|balance|insufficient|limit/i.test(_body)) {
      return 'KeyFault';
    }
    return 'ServerFault';
  }
  return 'ServerFault';
}


