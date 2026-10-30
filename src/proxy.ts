/**
 * proxy.ts — Hono HTTP proxy app. Saros predicts account exhaustion and cycles between accounts.
 *
 * Routes /zen/go/v1/* requests to the upstream API with automatic key
 * selection, circuit-breaker failover, and streaming pass-through.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rateLimiter } from 'hono-rate-limiter';
import type { Context } from 'hono';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createProxyState,
  selectKeyForRequest,
  failoverRequest,
  completeRequest,
  markKeyFailed,
  markKeySucceeded,
  classifyHttpError,
  type ProxyState,
  type KeySnapshot,
} from './proxy-logic.js';
import type { ProxyConfig } from './config.js';
import { logger, maskKey } from './logger.js';
import {
  MAX_BODY_SIZE,
  MAX_RETRIES,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
} from './constants.js';
import { getModelsList } from './models-fetcher.js';
import { maybeRefreshUsage } from './usage-client.js';
import { recordModelRequest } from './model-stats.js';
import { recordKeyTokens } from './token-usage.js';
import { getProvider, inferProvider } from './providers/index.js';
import type { KeyProvider, ProviderId } from './providers/index.js';

/** Canonical client-facing chat route prefix (the opencode-go shape). */
const CANONICAL_CHAT_BASE = '/zen/go/v1';

/**
 * Resolve the upstream URL for one attempt: per-provider base URL + path
 * remapping. Clients always speak canonical saros routes (/zen/go/v1/<rest>,
 * the opencode-go shape); requests routed to a provider with a different
 * chat surface get the prefix remapped (e.g. /provider/v1 for commandcode).
 */
export function resolveUpstreamUrl(config: ProxyConfig, provider: KeyProvider, path: string): string {
  const base = (config.upstreams?.[provider.id] ?? (provider.id === 'opencode-go' ? config.upstreamBaseUrl : provider.baseUrl))
    .replace(/\/+$/, '');
  if (provider.chatBasePath === CANONICAL_CHAT_BASE) {
    return buildUpstreamUrl(base, path);
  }
  const remapped = path.startsWith(CANONICAL_CHAT_BASE)
    ? provider.chatBasePath + path.slice(CANONICAL_CHAT_BASE.length)
    : path;
  return buildUpstreamUrl(base, remapped);
}

/**
 * Extract a provider-suffix routing hint from a model id
 * (e.g. 'claude-…@commandcode' → 'commandcode'). Returns null when absent.
 */
export function parseProviderSuffix(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const at = modelId.lastIndexOf('@');
  if (at <= 0 || at === modelId.length - 1) return null;
  return modelId.slice(at + 1);
}

/** Strip the @provider routing suffix from a model id for upstream forwarding. */
export function stripProviderSuffix(modelId: string): string {
  const at = modelId.lastIndexOf('@');
  return at > 0 ? modelId.slice(0, at) : modelId;
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Opt-in diagnostics: when SAROS_CAPTURE_4XX=1, write the full request
 * context of every upstream 4xx to <config dir>/captures/ so provider-side
 * errors (role validation, plan gating) can be replayed and debugged.
 * Never enabled by default — bodies may contain user content.
 */
function captureFailedRequest(ctx: RetryContext, status: number, errorBody: string): void {
  if (process.env.SAROS_CAPTURE_4XX !== '1') return;
  if (status < 400 || status >= 500) return;
  try {
    const dir = join(homedir(), '.config', 'saros', 'captures');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${ctx.requestId.slice(0, 8)}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          requestId: ctx.requestId,
          status,
          method: ctx.method,
          path: ctx.path,
          model: ctx.modelId ?? null,
          kind: ctx.kind,
          upstreamError: errorBody.slice(0, 2000),
          requestBody: ctx.bodyText.slice(0, 100_000),
        },
        null,
        2,
      ),
      'utf-8',
    );
    logger.warn({ requestId: ctx.requestId, file }, 'captured failing request (SAROS_CAPTURE_4XX)');
  } catch {
    // diagnostics must never break the proxy
  }
}

/**
 * Resolve the model id to send upstream for one attempt. An '@provider'
 * suffix is saros's routing shim and is always stripped; otherwise, when the
 * serving provider names the same model differently (bare name matches its
 * catalog under a vendor-prefixed id — e.g. 'deepseek-v4-flash' →
 * 'deepseek/deepseek-v4-flash' on commandcode), the provider's native id is
 * used so the upstream recognizes it. null when no rewrite is needed.
 */
function targetModelId(modelId: string | undefined, provider: KeyProvider): string | null {
  if (!modelId) return null;
  if (parseProviderSuffix(modelId)) return stripProviderSuffix(modelId);
  const bare = modelId.split('/').pop() ?? modelId;
  const native = provider.resolveNativeId?.(bare.toLowerCase());
  return native && native !== modelId ? native : null;
}

/** Outbound body plus the session id saros must add when the client sent none. */
export interface OutboundRequest {
  bodyText: string;
  /** Value for `provider.sessionHeader`; absent when the client supplied one. */
  sessionId?: string;
}

/**
 * Stable conversation fingerprint. The same conversation (same model, same
 * first user turn) maps to the same id on every request, so upstream routing
 * and prompt caching stay coherent, while a different conversation gets a
 * different id. The system prompt is deliberately excluded: harnesses
 * rewrite it on every turn (timestamps, injected context), which would make
 * the id change per request and defeat the purpose.
 */
function conversationSessionId(parsed: Record<string, unknown>, modelId: string | undefined): string {
  const messages: unknown[] = Array.isArray(parsed.messages) ? parsed.messages : [];
  const firstUser = messages.find(
    (message) => typeof message === 'object' && message !== null && !Array.isArray(message)
      && 'role' in message && message.role === 'user',
  );
  const seed = firstUser ?? messages.slice(0, 2);
  return crypto
    .createHash('sha256')
    .update(`${modelId ?? String(parsed.model ?? '')}\n${JSON.stringify(seed).slice(0, 4_000)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * [dsh-patch param-sanitize] 上游只接受固定几个 reasoning_effort 值，
 * 其它值（harness 自造、大小写变体）会被 400 拒绝。白名单外的直接删掉，
 * 让上游按默认档位处理，而不是让整轮请求失败。
 */
const ALLOWED_REASONING_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max']);

function sanitizeReasoningEffort(parsed: Record<string, unknown>): boolean {
  let changed = false;
  const top = parsed.reasoning_effort;
  if (typeof top === 'string' && !ALLOWED_REASONING_EFFORTS.has(top.toLowerCase())) {
    delete parsed.reasoning_effort;
    changed = true;
  }
  const reasoning = parsed.reasoning;
  if (typeof reasoning === 'object' && reasoning !== null && !Array.isArray(reasoning)) {
    const record = reasoning as Record<string, unknown>;
    if (typeof record.effort === 'string' && !ALLOWED_REASONING_EFFORTS.has(record.effort.toLowerCase())) {
      delete record.effort;
      changed = true;
    }
  }
  return changed;
}

/**
 * Prepare the outbound body for one attempt in a single JSON pass:
 *  - rewrite the model id for the serving provider (see targetModelId);
 *  - ask for streamed token usage (`stream_options.include_usage`) on chat
 *    completions, unless the client set the option itself — an explicit
 *    `false` is respected, otherwise the upstream may withhold the final
 *    usage chunk and per-key token accounting goes blind;
 *  - derive a conversation session id when the provider needs one and the
 *    client didn't send it (see conversationSessionId).
 *
 * The original text is returned untouched when nothing changes (or the body
 * isn't a JSON object), so most requests pay no re-serialization.
 */
export function prepareOutboundRequest(
  bodyText: string,
  modelId: string | undefined,
  provider: KeyProvider,
  options: { wantsStreamUsage: boolean; clientSessionId?: string },
): OutboundRequest {
  const parsed = parseRequestBody(bodyText);
  if (!parsed) return { bodyText };
  let changed = false;

  const target = targetModelId(modelId, provider);
  if (target && target !== parsed.model && typeof parsed.model === 'string') {
    parsed.model = target;
    changed = true;
  }

  // [dsh-patch param-sanitize] 清理上游不接受的值
  if (sanitizeReasoningEffort(parsed)) changed = true;

  if (options.wantsStreamUsage && provider.supportsStreamUsage) {
    const streamOptions = parsed.stream_options;
    const existing = typeof streamOptions === 'object' && streamOptions !== null && !Array.isArray(streamOptions)
      ? (streamOptions as Record<string, unknown>)
      : undefined;
    if (existing?.include_usage !== true && existing?.include_usage !== false) {
      parsed.stream_options = { ...existing, include_usage: true };
      changed = true;
    }
  }

  const sessionId = provider.sessionHeader && !options.clientSessionId
    ? conversationSessionId(parsed, modelId)
    : undefined;

  return { bodyText: changed ? JSON.stringify(parsed) : bodyText, sessionId };
}

/**
 * Provider for a key snapshot. Suffix-routed requests (​@provider model ids)
 * pin the provider; otherwise structural inference from the key itself.
 */
function providerForKey(key: KeySnapshot, config: ProxyConfig, modelId?: string): KeyProvider {
  const suffixProvider = parseProviderSuffix(modelId);
  if (suffixProvider) {
    const pinned = getProvider(suffixProvider as ProviderId);
    if (pinned) return pinned;
  }
  const inferred = inferProvider({ label: key.label, key: key.key });
  void config;
  return getProvider(inferred) ?? getProvider('opencode-go')!;
}

// Augment Hono's ContextVariableMap for @hono/node-server remote address
declare module 'hono' {
  interface ContextVariableMap {
    remote: { address: string };
  }
}

// ---------------------------------------------------------------------------
// [dsh-patch proxy-fallback] opencode 兜底代理
// ---------------------------------------------------------------------------

let proxyAgentCache: unknown = null;
let proxyAgentInitDone = false;

/** Lazily build an undici ProxyAgent from OPENCODE_PROXY (http(s) only, no socks). */
async function getProxyAgent(): Promise<unknown> {
  if (proxyAgentInitDone) return proxyAgentCache;
  proxyAgentInitDone = true;
  const url = process.env.OPENCODE_PROXY;
  if (!url) return null;
  try {
    const undici = await import('undici');
    proxyAgentCache = new undici.ProxyAgent(url);
    logger.info({ proxy: url.replace(/\/\/[^@/]*@/, '//***@') }, 'opencode proxy agent ready');
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err).slice(0, 160) }, 'opencode proxy agent init failed');
  }
  return proxyAgentCache;
}

/**
 * [dsh-patch same-key-retry] 值得"同 key 立即重试"的网络错误。
 * 排除 Connect Timeout：那说明到上游的路径整体不通，重试只会再等一个超时。
 */
function isRetryableSameKey(err: unknown): boolean {
  if (!isNetworkishError(err)) return false;
  const message = String((err as Error)?.message ?? err ?? '');
  const cause = String(((err as { cause?: { code?: string; message?: string } })?.cause?.code
    ?? (err as { cause?: { message?: string } })?.cause?.message) ?? '');
  return !(message + ' ' + cause).toLowerCase().includes('connect timeout');
}

/** Network-level failures worth retrying through the proxy. */
function isNetworkishError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err ?? '');
  const cause = String(((err as { cause?: { code?: string; message?: string } })?.cause?.code
    ?? (err as { cause?: { message?: string } })?.cause?.message) ?? '');
  const text = (message + ' ' + cause).toLowerCase();
  return ['fetch failed', 'timeout', 'econnreset', 'other side closed', 'tls', 'eai_again', 'socket', 'connect timeout']
    .some((needle) => text.includes(needle));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with configurable timeout using AbortController.
 * Returns 504 Gateway Timeout response if the request times out.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new TimeoutError('Request timed out');
    }
    throw err;
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Build upstream URL from base + request path.
 */
export function buildUpstreamUrl(base: string, path: string): string {
  // Strip trailing slash from base, ensure leading slash on path
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  // Reject path traversal attempts
  if (normalizedPath.includes('..')) {
    throw new Error('Path traversal detected');
  }
  return normalizedBase + normalizedPath;
}

/**
 * Clean headers for upstream forwarding: remove hop-by-hop headers,
 * pre-existing Authorization, and content-length (the forwarded body may be
 * rewritten — model-id aliasing / suffix strip — so a stale content-length
 * makes the upstream wait for bytes that never arrive; undici recomputes it
 * from the real body).
 */
export function buildUpstreamHeaders(
  incoming: Headers,
  bearerToken: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'proxy-authenticate' ||
      lower === 'proxy-authorization' ||
      lower === 'te' ||
      lower === 'transfer-encoding' ||
      lower === 'upgrade' ||
      lower === 'authorization' ||
      lower === 'content-length'
    ) {
      continue;
    }
    headers.set(key, value);
  }
  headers.set('Authorization', `Bearer ${bearerToken}`);
  return headers;
}

/**
 * Clean headers for downstream (client) response: strip hop-by-hop headers,
 * security-sensitive headers, internal debug headers, and content-length
 * (the Response constructor recalculates content-length automatically).
 */
export function buildDownstreamHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of upstreamHeaders) {
    const lower = key.toLowerCase();
    if (
      // Hop-by-hop headers (RFC 7230 §6.1)
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'proxy-authenticate' ||
      lower === 'proxy-authorization' ||
      lower === 'te' ||
      lower === 'trailer' ||
      lower === 'transfer-encoding' ||
      lower === 'upgrade' ||
      // Security-sensitive
      lower === 'set-cookie' ||
      // Body is already decoded: Node fetch transparently gunzips upstream
      // responses, so forwarding content-encoding would make clients try to
      // decompress plain text (found live against api.commandcode.ai).
      lower === 'content-encoding' ||
      // The forwarded body may be rewritten (model-id aliasing/suffix strip),
      // so a forwarded content-length can disagree with the actual body and
      // hang the upstream waiting for missing bytes (found live). Undici
      // recomputes content-length from the real body.
      lower === 'content-length' ||
      // Internal debug
      lower === 'x-request-id' ||
      // Response constructor recalculates content-length
      lower === 'content-length'
    ) {
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

/**
 * Check if a request body indicates streaming mode.
 */
export function isStreamingRequest(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed.stream === true;
  } catch {
    return false;
  }
}

/** Single JSON parse of a request body; null on invalid/missing input. */
function parseRequestBody(bodyText: string): Record<string, unknown> | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upstream forwarding with failover
// ---------------------------------------------------------------------------

type RequestKind = 'standard' | 'streaming';

type SuccessHandler = (
  response: Response,
  state: ProxyState,
  requestId: string,
  keyLabel: string,
) => Promise<Response>;

interface RetryContext {
  state: ProxyState;
  requestId: string;
  config: ProxyConfig;
  method: string;
  path: string;
  incomingHeaders: Headers;
  bodyText: string;
  kind: RequestKind;
  /** Model id parsed from the request body (for affinity routing); optional. */
  modelId?: string;
  onSuccess: SuccessHandler;
  /** [dsh-patch same-key-retry] 每个请求允许 1 次"同 key 网络重试"。 */
  sameKeyRetryBudget?: number;
}

type AttemptResult =
  | { kind: 'done'; response: Response }
  | { kind: 'retry'; lastError: Error | null };

/**
 * Shared retry loop for both streaming and non-streaming requests.
 * Handles key selection, failover, error classification, and retry logic.
 * Delegates the success-path response construction to `ctx.onSuccess`.
 */
async function executeWithRetry(opts: {
  state: ProxyState;
  requestId: string;
  config: ProxyConfig;
  method: string;
  path: string;
  incomingHeaders: Headers;
  bodyText: string;
  kind: RequestKind;
  modelId?: string;
  onSuccess: SuccessHandler;
  maxRetries: number;
}): Promise<Response> {
  const ctx: RetryContext = {
    state: opts.state,
    requestId: opts.requestId,
    config: opts.config,
    method: opts.method,
    path: opts.path,
    incomingHeaders: opts.incomingHeaders,
    bodyText: opts.bodyText,
    kind: opts.kind,
    modelId: opts.modelId,
    onSuccess: opts.onSuccess,
    sameKeyRetryBudget: 1,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    const result = await executeSingleAttempt(attempt, ctx);
    if (result.kind === 'done') return result.response;
    lastError = result.lastError;
  }

  return handleAllRetriesFailed(ctx, opts.maxRetries, lastError);
}

async function executeSingleAttempt(attempt: number, ctx: RetryContext): Promise<AttemptResult> {
  const key = pickKey(ctx, attempt);
  if (!key) {
    return { kind: 'done', response: buildNoKeysResponse(ctx.state, ctx.requestId, ctx.kind, attempt) };
  }

  logKeyAttempt(ctx.requestId, key, attempt, ctx.kind);
  // Per-attempt upstream: keys may be mixed-provider within one failover chain.
  // Suffix-routed models (@provider) pin the provider and lose the suffix
  // in the forwarded body; the upstream never sees saros's routing shim.
  const provider = providerForKey(key, ctx.config, ctx.modelId);
  const upstreamUrl = resolveUpstreamUrl(ctx.config, provider, ctx.path);
  const sessionHeader = provider.sessionHeader;
  const prepared = ctx.bodyText
    ? prepareOutboundRequest(ctx.bodyText, ctx.modelId, provider, {
        // `stream_options` is a Chat Completions field — never inject it into
        // other streaming surfaces (e.g. the Responses API).
        wantsStreamUsage: ctx.kind === 'streaming' && ctx.path.endsWith('/chat/completions'),
        clientSessionId: sessionHeader
          ? ctx.incomingHeaders.get(sessionHeader) ?? undefined
          : undefined,
      })
    : { bodyText: ctx.bodyText };
  const fetchOptions = buildFetchOptions({
    method: ctx.method,
    bodyText: prepared.bodyText,
    kind: ctx.kind,
    incomingHeaders: ctx.incomingHeaders,
    bearerToken: key.key,
    provider,
    sessionId: prepared.sessionId,
  });

  // [dsh-patch req-metrics] 面板需要"每次请求"的 model / 耗时 / 请求体大小
  const attemptStartedAt = Date.now();
  try {
    const response = await fetchWithTimeout(upstreamUrl, fetchOptions, ctx.config.requestTimeoutMs);
    if (response.ok) {
      markKeySucceeded(ctx.state, key.label);
      completeRequest(ctx.state, ctx.requestId, true);
      const downstream = await ctx.onSuccess(response, ctx.state, ctx.requestId, key.label);
      logger.info(
        {
          requestId: ctx.requestId,
          keyLabel: key.label,
          model: ctx.modelId,
          kind: ctx.kind,
          status: response.status,
          attempt,
          durationMs: Date.now() - attemptStartedAt,
          bodyBytes: ctx.bodyText.length,
        },
        'request metrics',
      );
      return { kind: 'done', response: downstream };
    }
    return await handleUpstreamErrorResponse(response, ctx, key);
  } catch (err) {
    // [dsh-patch same-key-retry] 网络类失败（且不是 Connect Timeout —— 那说明路径断了）时，
    // 先用 10s 短超时对同一把 key 再试一次：瞬时 ECONNRESET / other side closed 常能一次救回，
    // 且失败发生在收到首字节前，不会重复计费。仍失败再走代理兜底 → failover。
    if (isRetryableSameKey(err) && (ctx.sameKeyRetryBudget ?? 0) > 0) {
      ctx.sameKeyRetryBudget = (ctx.sameKeyRetryBudget ?? 1) - 1;
      // 超时按体积自适应（与代理兜底同一套公式）：固定 10s 会输在 1MB+ 的 body 上
      // （实测 78 次同 key 重试超时，救回的请求 p50 就有 1054KB）。
      const retryBase = Number(process.env.SAME_KEY_RETRY_TIMEOUT_MS ?? 0) || 10_000;
      const retryBytesPerSec = Number(process.env.SAME_KEY_RETRY_BYTES_PER_SEC
        ?? process.env.PROXY_FALLBACK_BYTES_PER_SEC ?? 0) || 40_000;
      const retryTimeoutMax = Number(process.env.SAME_KEY_RETRY_TIMEOUT_MAX_MS
        ?? process.env.PROXY_FALLBACK_TIMEOUT_MAX_MS ?? 0) || 45_000;
      const retryTimeout = Math.min(
        retryTimeoutMax,
        Math.round(retryBase + (ctx.bodyText.length / retryBytesPerSec) * 1000),
      );
      try {
        const retried = await fetchWithTimeout(upstreamUrl, fetchOptions, retryTimeout);
        if (retried.ok) {
          logger.info({ requestId: ctx.requestId, keyLabel: key.label, provider: provider.id,
            timeoutMs: retryTimeout, bodyBytes: ctx.bodyText.length }, 'same-key retry succeeded');
          markKeySucceeded(ctx.state, key.label);
          completeRequest(ctx.state, ctx.requestId, true);
          return { kind: 'done', response: await ctx.onSuccess(retried, ctx.state, ctx.requestId, key.label) };
        }
        logger.warn({ requestId: ctx.requestId, keyLabel: key.label, status: retried.status },
          'same-key retry got non-ok');
      } catch (retryErr) {
        logger.warn({ requestId: ctx.requestId, keyLabel: key.label,
          timeoutMs: retryTimeout, bodyBytes: ctx.bodyText.length,
          err: String((retryErr as Error)?.message ?? retryErr).slice(0, 120) }, 'same-key retry failed');
      }
    }

    // [dsh-patch proxy-fallback] 网络类失败时，同一 attempt 内经 HTTP 代理再试一次（不占重试次数、不换 key）。
    // env:
    //   OPENCODE_PROXY           代理地址（http(s)，undici 不支持 socks）
    //   PROXY_FALLBACK_MODE      fallback|off（默认 fallback）
    //   PROXY_FALLBACK_PROVIDERS 逗号分隔，默认 "opencode-go,commandcode"（两家都在 CF 后面，会同时抖）
    //   PROXY_FALLBACK_TIMEOUT_MS 单次兜底超时，默认 12000（此前沿用主超时的 45s，失败时占用过久）
    //   PROXY_FALLBACK_MAX_BYTES  只对不超过该体积的请求兜底，默认 1MB（大 body 走代理更慢、更易超时）
    const fallbackMode = process.env.PROXY_FALLBACK_MODE ?? process.env.OPENCODE_PROXY_MODE ?? 'fallback';
    const fallbackProviders = (process.env.PROXY_FALLBACK_PROVIDERS ?? 'opencode-go,commandcode')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const fallbackMaxBytes = Number(process.env.PROXY_FALLBACK_MAX_BYTES ?? 1024 * 1024);
    // 超时按体积自适应：代理吞吐约 27–70KB/s，固定 12s 会让大 body 输在半路
    // （实测 57 次 12s 超时里绝大多数是 300KB+ 的请求）。timeout = base + bytes/rate，封顶 max。
    const fallbackTimeoutBase = Number(process.env.PROXY_FALLBACK_TIMEOUT_MS ?? 0) || 12_000;
    const fallbackBytesPerSec = Number(process.env.PROXY_FALLBACK_BYTES_PER_SEC ?? 0) || 40_000;
    const fallbackTimeoutMax = Number(process.env.PROXY_FALLBACK_TIMEOUT_MAX_MS ?? 0) || 45_000;
    const fallbackTimeoutMs = Math.min(
      fallbackTimeoutMax,
      Math.round(fallbackTimeoutBase + (ctx.bodyText.length / fallbackBytesPerSec) * 1000),
    );
    const withinSizeGate = !fallbackMaxBytes || ctx.bodyText.length <= fallbackMaxBytes;
    if (fallbackMode !== 'off' && withinSizeGate && fallbackProviders.includes(provider.id) && isNetworkishError(err)) {
      try {
        const agent = await getProxyAgent();
        if (agent) {
          const retryInit: RequestInit & { dispatcher?: unknown; duplex?: 'half' } = { ...fetchOptions, dispatcher: agent };
          const retried = await fetchWithTimeout(upstreamUrl, retryInit, fallbackTimeoutMs);
          if (retried.ok) {
            logger.info({ requestId: ctx.requestId, keyLabel: key.label, model: ctx.modelId, provider: provider.id,
              via: 'proxy', timeoutMs: fallbackTimeoutMs, bodyBytes: ctx.bodyText.length },
              'fallback via proxy succeeded');
            markKeySucceeded(ctx.state, key.label);
            completeRequest(ctx.state, ctx.requestId, true);
            return { kind: 'done', response: await ctx.onSuccess(retried, ctx.state, ctx.requestId, key.label) };
          }
          logger.warn({ requestId: ctx.requestId, keyLabel: key.label, provider: provider.id,
            status: retried.status, via: 'proxy' }, 'fallback via proxy got non-ok');
        }
      } catch (fallbackErr) {
        logger.warn({ requestId: ctx.requestId, keyLabel: key.label, provider: provider.id,
          timeoutMs: fallbackTimeoutMs, bodyBytes: ctx.bodyText.length,
          err: String((fallbackErr as Error)?.message ?? fallbackErr).slice(0, 140) },
          'fallback via proxy failed');
      }
    }
    return handleNetworkError(err, ctx, key);
  }
}

/**
 * [dsh-patch failover-affinity] 判断某 provider 能否服务这个 model id。
 *
 * 只对"必须把裸名改写成 provider 原生 id、却解析不出来"的情况否决：
 * commandcode 需要 deepseek-v4.1-flash → deepseek/deepseek-v4.1-flash，目录未加载
 * 或目录里没有该模型时改不出来，发过去就是 400
 * 「Model ... is not supported on this endpoint」（RequestFault 不重试，直接透传）。
 * 其它 provider（如 opencode-go）没有原生 id 改写，一律放行——它们的 catalog 可能
 * 还没加载，用 affinity 'no' 否决会误伤正常的 failover。
 */
function providerCanServe(provider: KeyProvider, modelId: string | undefined): boolean {
  if (!provider || !modelId) return true;
  if (provider.modelAffinity(modelId) === 'yes') return true;
  if (parseProviderSuffix(modelId)) return true;
  // 只有"必须把裸名改写成 vendor 前缀原生 id"的 provider 才做硬性否决
  // （commandcode: deepseek-v4.1-flash → deepseek/deepseek-v4.1-flash）。
  // opencode-go 的裸名本身就是原生 id，resolveNativeId 为 null 不代表不能服务，
  // 拿它否决会把正常 failover 打死（503 No keys available）。
  if (provider.id !== 'commandcode') return true;
  const resolveNativeId = provider.resolveNativeId;
  if (!resolveNativeId) return true;
  const bare = (modelId.split('/').pop() ?? modelId).toLowerCase();
  return resolveNativeId.call(provider, bare) !== null;
}

function pickKey(ctx: RetryContext, attempt: number): KeySnapshot | null {
  if (attempt === 0) return selectKeyForRequest(ctx.state, ctx.requestId, ctx.modelId);
  // [dsh-patch failover-affinity] 逐个取候选，跳过"该 provider 服务不了此 model"的 key，
  // 避免把裸 id 发到 commandcode 换来 400（RequestFault 不会重试，直接透传给客户端）。
  for (let i = 0; i < 8; i++) {
    const next = failoverRequest(ctx.state, ctx.requestId);
    if (!next) return null;
    const provider = providerForKey(next, ctx.config, ctx.modelId);
    if (providerCanServe(provider, ctx.modelId)) return next;
    logger.warn(
      { requestId: ctx.requestId, keyLabel: next.label, model: ctx.modelId, provider: provider.id },
      'skip failover key: provider cannot serve this model',
    );
  }
  return null;
}

function buildFetchOptions(opts: {
  method: string;
  bodyText: string;
  kind: RequestKind;
  incomingHeaders: Headers;
  bearerToken: string;
  provider?: KeyProvider;
  /** Derived conversation id, added only when the client sent none. */
  sessionId?: string;
}): RequestInit & { duplex?: 'half' } {
  const headers = buildUpstreamHeaders(opts.incomingHeaders, opts.bearerToken);
  // Provider-specific identity headers (e.g. CommandCode CLI headers)
  if (opts.provider?.extraUpstreamHeaders) {
    for (const [name, value] of Object.entries(opts.provider.extraUpstreamHeaders())) {
      headers.set(name, value);
    }
  }
  // Some upstreams require a stable per-conversation session id and reject
  // requests without one (OpenCode Go: 400 MissingSessionID). A client that
  // sends its own value keeps it — it was forwarded verbatim above.
  if (opts.sessionId && opts.provider?.sessionHeader) {
    headers.set(opts.provider.sessionHeader, opts.sessionId);
  }
  const options: RequestInit & { duplex?: 'half' } = { method: opts.method, headers };
  if (!opts.bodyText) return options;
  // Node.js fetch requires `duplex: 'half'` when body is a stream or string
  // that may be streamed. TypeScript's DOM RequestInit lacks this field.
  if (opts.kind === 'standard' && (opts.method === 'GET' || opts.method === 'HEAD')) return options;
  options.body = opts.bodyText;
  options.duplex = 'half';
  return options;
}

async function handleUpstreamErrorResponse(
  response: Response,
  ctx: RetryContext,
  key: KeySnapshot,
): Promise<AttemptResult> {
  const errorBody = await response.text();
  const errorType = classifyHttpError(response.status, errorBody);
  logUpstreamError(ctx.requestId, key, response.status, errorType, errorBody, ctx.kind);
  captureFailedRequest(ctx, response.status, errorBody);

  if (errorType === 'RequestFault') {
    // Client error — don't retry, don't penalise the key
    completeRequest(ctx.state, ctx.requestId, false);
    return { kind: 'done', response: buildClientErrorResponse(response.status, errorBody, ctx.requestId) };
  }

  // KeyFault or ServerFault — penalise the key and retry
  markKeyFailed(ctx.state, key.label, errorType);
  const lastError = ctx.kind === 'standard'
    ? new Error(`Upstream error ${response.status}: ${errorBody.slice(0, 200)}`)
    : null;
  return { kind: 'retry', lastError };
}

function handleNetworkError(err: unknown, ctx: RetryContext, key: KeySnapshot): AttemptResult {
  const lastError = err instanceof Error ? err : new Error(String(err));
  // Timeouts / connection errors are shared-upstream failures, not per-key
  // faults: penalising them disabled every key during upstream hangs and
  // locked the proxy into "all keys unavailable" until cooldown expired.
  if (lastError instanceof TimeoutError) {
    logTimeout(ctx.requestId, key, ctx.config.requestTimeoutMs, ctx.kind);
  } else {
    logNetworkError(ctx.requestId, key, err, ctx.kind);
  }
  markKeyFailed(ctx.state, key.label, 'NetworkFault');
  return { kind: 'retry', lastError };
}

function buildNoKeysResponse(state: ProxyState, requestId: string, kind: RequestKind, attempt: number): Response {
  logger.warn(
    { requestId, attempt, kind },
    kind === 'standard'
      ? 'No API keys available on attempt %d'
      : 'No API keys available for streaming on attempt %d',
    attempt,
  );
  completeRequest(state, requestId, false);
  return new Response(
    JSON.stringify({ error: 'All API keys are temporarily unavailable', requestId }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

function buildClientErrorResponse(status: number, errorBody: string, requestId: string): Response {
  // Sanitize upstream error - don't leak internal details
  let safeError: string;
  try {
    const parsed = JSON.parse(errorBody);
    const message = parsed.error?.message || parsed.error || 'Bad Request';
    safeError = JSON.stringify({ error: message, requestId });
  } catch {
    safeError = JSON.stringify({ error: 'Bad Request', requestId });
  }
  return new Response(safeError, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function handleAllRetriesFailed(ctx: RetryContext, maxRetries: number, lastError: Error | null): Response {
  completeRequest(ctx.state, ctx.requestId, false);
  logger.error(
    { requestId: ctx.requestId, err: lastError, kind: ctx.kind },
    ctx.kind === 'standard'
      ? 'All %d retries exhausted, returning 502'
      : 'Streaming failed after %d attempts',
    maxRetries,
  );
  const message = ctx.kind === 'standard'
    ? 'Upstream service unavailable after multiple attempts'
    : 'Streaming service unavailable after multiple attempts';
  return new Response(
    JSON.stringify({ error: 'Bad Gateway', message, requestId: ctx.requestId }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  );
}

// --- Logging helpers (preserve original log message format) ---

function logKeyAttempt(requestId: string, key: KeySnapshot, attempt: number, kind: RequestKind): void {
  logger.info(
    { requestId, keyLabel: key.label, attempt, kind },
    kind === 'standard'
      ? 'Forwarding request to upstream using key %s'
      : 'Streaming request with key %s',
    maskKey(key.key),
  );
}

/**
 * [dsh-patch req-tokens] 从上游 `usage` 对象里取 token 计数（OpenAI 形状与
 * Anthropic 形状都兼容），供面板按小时聚合 token 用量。
 */
function tokenCounts(usage: unknown): { tokIn: number; tokOut: number } | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const pick = (a: string, b: string): number | null => {
    const value = record[a] ?? record[b];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const tokIn = pick('prompt_tokens', 'input_tokens');
  const tokOut = pick('completion_tokens', 'output_tokens');
  if (tokIn === null && tokOut === null) return null;
  return { tokIn: tokIn ?? 0, tokOut: tokOut ?? 0 };
}

function logUpstreamError(
  requestId: string,
  key: KeySnapshot,
  status: number,
  errorType: string,
  errorBody: string,
  kind: RequestKind,
): void {  if (kind === 'standard') {
    logger.warn(
      { requestId, keyLabel: key.label, status, errorType, kind },
      'Upstream returned error: %s',
      errorBody.slice(0, 200),
    );
  } else {
    logger.warn(
      { requestId, keyLabel: key.label, status, kind },
      'Upstream streaming error',
    );
  }
}

function logTimeout(requestId: string, key: KeySnapshot, timeoutMs: number, kind: RequestKind): void {
  logger.warn(
    { requestId, keyLabel: key.label, kind },
    kind === 'standard'
      ? 'Request timed out after %dms, retrying with next key'
      : 'Streaming request timed out after %dms, retrying with next key',
    timeoutMs,
  );
}

function logNetworkError(requestId: string, key: KeySnapshot, err: unknown, kind: RequestKind): void {
  logger.error(
    { requestId, keyLabel: key.label, err, kind },
    kind === 'standard'
      ? 'Network error forwarding to upstream'
      : 'Network error during streaming',
  );
}

// ---------------------------------------------------------------------------
// Success handlers
// ---------------------------------------------------------------------------

const standardSuccessHandler: SuccessHandler = async (response, state, requestId, keyLabel) => {
  logger.info(
    { requestId, keyLabel, status: response.status },
    'Upstream request succeeded',
  );
  const responseBody = await response.text();
  // Non-streaming bodies report the request's token usage at the top level
  // (OpenAI shape); recording it is what makes `saros-proxy usage` show real
  // consumption for providers with no quota API (CommandCode).
  const usage = parseRequestBody(responseBody)?.usage;
  recordKeyTokens(keyLabel, usage);
  // [dsh-patch req-tokens] 逐请求 token 进日志（面板按小时聚合）
  const counts = tokenCounts(usage);
  if (counts) logger.info({ requestId, keyLabel, tokIn: counts.tokIn, tokOut: counts.tokOut }, 'request tokens');
  const downstreamHeaders = buildDownstreamHeaders(response.headers);
  downstreamHeaders.set('X-Proxy-Key-Label', keyLabel);
  downstreamHeaders.set('X-Proxy-Request-Id', requestId);
  return new Response(responseBody, {
    status: response.status,
    headers: downstreamHeaders,
  });
};

const streamingSuccessHandler: SuccessHandler = async (response, state, requestId, keyLabel) => {
  if (!response.body) {
    logger.error({ requestId, keyLabel }, 'Streaming response missing body');
    return new Response(
      JSON.stringify({ error: 'Bad Gateway', message: 'Upstream response missing body', requestId }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
  const wrappedStream = wrapStreamWithErrorDetection(response.body, state, requestId, keyLabel);
  const responseHeaders = buildDownstreamHeaders(response.headers);
  responseHeaders.set('content-type', 'text/event-stream');
  responseHeaders.set('cache-control', 'no-cache');
  responseHeaders.set('connection', 'keep-alive');
  responseHeaders.set('X-Proxy-Key-Label', keyLabel);
  responseHeaders.set('X-Proxy-Request-Id', requestId);
  return new Response(wrappedStream, { status: 200, headers: responseHeaders });
};

interface HandleRequestOptions {
  state: ProxyState;
  requestId: string;
  config: ProxyConfig;
  method: string;
  path: string;
  incomingHeaders: Headers;
  bodyText: string;
  /** Model id from the request body — drives provider-affinity routing. */
  modelId?: string;
  maxRetries?: number;
}

/**
 * Forward a (non-streaming) request to the upstream with automatic
 * key failover on KeyFault and ServerFault responses.
 */
async function handleWithFailover(opts: HandleRequestOptions): Promise<Response> {
  return executeWithRetry({
    state: opts.state,
    requestId: opts.requestId,
    config: opts.config,
    method: opts.method,
    path: opts.path,
    incomingHeaders: opts.incomingHeaders,
    bodyText: opts.bodyText,
    kind: 'standard',
    modelId: opts.modelId,
    onSuccess: standardSuccessHandler,
    maxRetries: opts.maxRetries ?? MAX_RETRIES,
  });
}

/**
 * Handle a streaming request with automatic key failover and mid-stream
 * error detection.  Streams SSE chunks directly to the client and wraps
 * the stream to detect error markers mid-response.
 */
async function handleStreamingRequest(opts: HandleRequestOptions): Promise<Response> {
  return executeWithRetry({
    state: opts.state,
    requestId: opts.requestId,
    config: opts.config,
    method: opts.method,
    path: opts.path,
    incomingHeaders: opts.incomingHeaders,
    bodyText: opts.bodyText,
    kind: 'streaming',
    modelId: opts.modelId,
    onSuccess: streamingSuccessHandler,
    maxRetries: opts.maxRetries ?? MAX_RETRIES,
  });
}

/**
 * Wrap an upstream SSE stream with error detection.
 * Parses SSE events properly to avoid false positives on
 * `"error"` appearing in non-error JSON payloads.
 * If an error marker is detected mid-stream, the failed key is penalised,
 * a proxy_error SSE event is sent to the client, and the stream is closed.
 */
function wrapStreamWithErrorDetection(
  upstreamStream: ReadableStream<Uint8Array>,
  state: ProxyState,
  requestId: string,
  keyLabel: string,
): ReadableStream<Uint8Array> {
  const reader = upstreamStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  // Upstreams may report the same `usage` on more than one chunk: CommandCode
  // sends it on the finish chunk (`choices[0].finish_reason`) and again on the
  // trailing usage-only chunk (`choices: []`), so booking per chunk would
  // count every streamed request twice. Keep the canonical usage-only chunk
  // (last one wins, OpenAI's `include_usage` contract) and fall back to the
  // finish chunk's copy; book exactly once, when the stream ends.
  let lastUsage: unknown = null;
  let usageOnlyChunk: unknown = null;
  let usageBooked = false;
  const bookUsage = (): void => {
    if (usageBooked) return;
    usageBooked = true;
    const usage = usageOnlyChunk ?? lastUsage;
    recordKeyTokens(keyLabel, usage);
    // [dsh-patch req-tokens] 流式请求在结束时把 token 记进日志
    const counts = tokenCounts(usage);
    if (counts) logger.info({ requestId, keyLabel, tokIn: counts.tokIn, tokOut: counts.tokOut }, 'request tokens');
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          bookUsage();
          controller.close();
          return;
        }

        // Decode chunk and parse SSE events
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // SSE events are delimited by \n\n
        const events = buffer.split('\n\n');
        // Keep the last incomplete event (partial data) in the buffer
        buffer = events.pop() || '';

        for (const event of events) {
          const dataLine = event.split('\n').find(line => line.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(5).trim());
            if (parsed && (parsed.error || parsed.type === 'error')) {
              logger.warn({ requestId, keyLabel }, 'Error detected in stream');
              markKeyFailed(state, keyLabel, 'ServerFault');
              // Whatever the upstream reported before failing was consumed.
              bookUsage();
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"proxy_error","message":"Upstream stream error"}\n\n',
                ),
              );
              controller.close();
              return;
            }
            // Intermediate chunks send `usage: null`; the counts arrive on the
            // finish chunk and/or the usage-only chunk (see bookUsage).
            if (parsed?.usage) {
              lastUsage = parsed.usage;
              if (Array.isArray(parsed.choices) && parsed.choices.length === 0) {
                usageOnlyChunk = parsed.usage;
              }
            }
          } catch {
            // Invalid JSON in SSE event — not an error we can classify, ignore
          }
        }

        // Pass through the chunk as-is
        controller.enqueue(value);
      } catch (err) {
        logger.error({ requestId, keyLabel, err }, 'Stream read error');
        markKeyFailed(state, keyLabel, 'ServerFault');
        bookUsage();
        controller.enqueue(
          encoder.encode(
            'data: {"type":"proxy_error","message":"Stream interrupted"}\n\n',
          ),
        );
        controller.close();
      }
    },

    cancel() {
      // The client hung up, but the upstream already spent the tokens.
      bookUsage();
      reader.cancel();
    },
  });
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createProxyApp(config: ProxyConfig): Hono {
  const state: ProxyState = createProxyState(config.keys, {
    circuitBreakerThreshold: config.circuitBreakerThreshold,
    circuitBreakerCooldownMs: config.circuitBreakerCooldownMs,
  });
  // Model→provider affinity: requests naming a provider-specific model
  // (e.g. commandcode's vendor-prefixed ids) are routed to a matching key
  // first; 'maybe' providers remain as fallback. Bare-name matching lets
  // shared models (deepseek-v4-flash etc.) rotate across ALL serving keys
  // cross-provider. No-op for single-provider pools and when no provider
  // claims the model.
  state.affinityResolver = (providerId, modelId) => {
    // [dsh-patch] 显式钉住（model@provider）优先于目录亲和：客户端已经指明 provider，
    // 不能因为该 provider 的 catalog 还没加载（冷启动返回 'no'）就拒绝服务。
    const pinned = parseProviderSuffix(modelId);
    if (pinned && pinned === providerId) return 'yes';
    const provider = getProvider(providerId as ProviderId);
    if (!provider) return 'maybe';
    const direct = provider.modelAffinity(modelId);
    if (direct !== 'maybe') return direct;
    // Bare-name cross-check: 'deepseek-v4-flash' may be commandcode's
    // 'deepseek/deepseek-v4-flash'.
    const bare = (modelId.split('/').pop() ?? modelId).toLowerCase();
    return provider.modelAffinityByName?.(bare) ?? 'maybe';
  };

  const app = new Hono();

  // --- Rate limiting (prevent DoS and key exhaustion) ---
  app.use('*', rateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX,
    standardHeaders: true, // Return rate limit info in headers
    keyGenerator: (c) => {
      const forwarded = c.req.header('x-forwarded-for');
      if (forwarded) return forwarded.split(',')[0].trim();
      const realIp = c.req.header('x-real-ip');
      if (realIp) return realIp;
      // Fall back to socket remote address for direct connections
      // c.get('remote') is set by @hono/node-server via ContextVariableMap augmentation
      return c.get('remote')?.address ?? 'unknown';
    },
    message: { error: 'Too many requests, please try again later' },
  }));

  // --- CORS (configurable origins) ---
  app.use(
    '*',
    cors({
      origin: (origin: string) => {
        if (!origin) return null; // Non-browser requests (no Origin header) — skip CORS
        const allowed = config.allowedOrigins.some((pattern) => {
          // Escape regex special chars, then replace \* with .*
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
          const regex = new RegExp('^' + escaped.replaceAll(String.raw`\*`, '.*') + '$');
          return regex.test(origin);
        });
        if (allowed) return origin;
        logger.warn('CORS violation: origin "%s" not allowed', origin);
        return null;
      },
    }),
  );

  // --- Health check ---
  app.get('/health', (c: Context) => {
    const keys = state.keys;
    const enabledCount = keys.filter((k) => k.enabled).length;
    const disabledCount = keys.length - enabledCount;
    const activeCount = state.activeRequests.size;

    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      keyCount: keys.length,
      enabledCount,
      disabledCount,
      // Keys whose account has no plan for their provider (403 entitlement):
      // kept out of rotation until the usage refresh clears the flag.
      entitledCount: keys.filter((k) => k.entitled).length,
      activeRequests: activeCount,
      circuitBreakerThreshold: state.circuitBreakerThreshold,
      circuitBreakerCooldownMs: state.circuitBreakerCooldownMs,
      // Per-provider key counts (multi-provider pools)
      providers: keys.reduce<Record<string, { total: number; enabled: number }>>((acc, k) => {
        const entry = (acc[k.provider] ??= { total: 0, enabled: 0 });
        entry.total++;
        if (k.enabled) entry.enabled++;
        return acc;
      }, {}),
    });
  });

  // --- Models discovery endpoint (OpenAI-compatible) ---
  // Returns the full model list so the OpenCode client can discover all
  // available models. Without this, OpenCode falls back to a hardcoded
  // list of ~3 models (one per series).
  // NOTE: Rate limiting applies to these routes via the '*' middleware above.
  app.get('/v1/models', (_c: Context) => getModelsList(config));
  app.get('/zen/go/v1/models', (_c: Context) => getModelsList(config));

  // [dsh-patch models-single] 单模型查询在本地回 404：客户端（含 DSH）会探测
  // /models/<id>，透传到上游只会换来一串 404 噪音（实测一天 133 次）。
  const modelNotFound = (c: Context): Response =>
    c.json(
      {
        error: {
          message: `Model '${c.req.param('id') ?? ''}' not found`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      },
      404,
    );
  app.get('/v1/models/:id', modelNotFound);
  app.get('/zen/go/v1/models/:id', modelNotFound);

  // --- Upstream proxy handler (reused by both routes) ---
  async function handleProxyRequest(c: Context, path: string): Promise<Response> {
    const requestId = generateRequestId();
    const method = c.req.method;
    const incomingHeaders = c.req.raw.headers;

    // Reject oversized requests early via Content-Length header
    const contentLength = c.req.header('content-length');
    if (contentLength && Number.parseInt(contentLength) > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large', requestId }, 413);
    }

    // Read the body text once (needed for streaming detection and forwarding)
    const bodyText = method === 'GET' || method === 'HEAD' ? '' : await c.req.text();

    // Reject requests whose actual body exceeds the limit
    if (bodyText.length > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large', requestId }, 413);
    }

    maybeRefreshUsage(state, config);

    // Parse once: used for both streaming detection and model tracking
    const parsedBody = parseRequestBody(bodyText);

    // Track most-used models for `saros-proxy usage` (best-effort)
    if (parsedBody) {
      const model = parsedBody.model;
      if (typeof model === 'string' && model.length > 0) recordModelRequest(model);
    }

    // Check for streaming mode
    if (parsedBody?.stream === true) {
      logger.info({ requestId, method, path }, 'Streaming request detected');
      return handleStreamingRequest({
        state,
        requestId,
        config,
        method,
        path,
        incomingHeaders,
        bodyText,
        modelId: typeof parsedBody.model === 'string' ? parsedBody.model : undefined,
      });
    }

    // Non-streaming request with failover
    return handleWithFailover({
      state,
      requestId,
      config,
      method,
      path,
      incomingHeaders,
      bodyText,
      modelId: typeof parsedBody?.model === 'string' ? parsedBody.model : undefined,
    });
  }

  // Unified catch-all: rewrites /v1/* → /zen/go/v1/* for upstream forwarding
  app.all('/zen/go/v1/*', (c: Context) => handleProxyRequest(c, c.req.path));
  // OpenAI-compatible proxy path — lets standard API clients (e.g. Odysseus,
  // Cursor, LibreChat) use the proxy without the /zen/go/ prefix.
  // The path is rewritten to the upstream's native prefix so the upstream
  // receives /zen/go/v1/... and returns a valid response.
  app.all('/v1/*', (c: Context) => handleProxyRequest(c, c.req.path.replace('/v1/', '/zen/go/v1/')));

  return app;
}
