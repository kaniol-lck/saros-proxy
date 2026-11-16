# AGENTS.md — Project Instructions for AI Agents

## Project Overview

**saros-proxy** — Predictive multi-account proxy for the OpenCode-Go API. Cycles between accounts before they exhaust.

- **Language:** TypeScript (ESM, `"type": "module"`)
- **Runtime:** Node.js >= 20
- **Framework:** Hono (HTTP), Pino (logging)
- **Test:** Vitest 4.x
- **Build:** `tsc` → `dist/`

## 铁律 0：不要把「临时状态」当成「事实」写死进代码

> 这是本项目**优先级最高**的约定，高于下面任何设计说明。
> 本代理跨三个上游、多个账号池、若干中转网关，**可用性、额度、模型分布、链路质量
> 每小时都在变**。任何"某家现在不行/某路更快/某模型在哪"的结论都是**观测**，
> 不是**契约**。把观测写死进代码 = 把昨天的天气写进日历。

### 0.1 两类事实，必须分清

| | 可以写死（契约 / 结构） | 禁止写死（状态 / 观测） |
|---|---|---|
| 例子 | URL 路径 `/v1/chat/completions`；必填头 `x-opencode-session`；错误码语义（401=鉴权、`no_healthy_account`=池内无健康账号）；SSE 帧格式 `data: …\n\n`；厂商原生 id 要加前缀 | 哪家当前可用；哪个 realm（`global:` / `cn:`）有货；某模型挂在哪个账号；剩余额度；哪条链路更快；多大的 body 会挂；代理端口是否在线；某家的重置时刻 |
| 判断法 | 与时间无关，厂商不变就会一直成立 | **会随时间/流量/计费周期改变** |

### 0.2 禁止事项（反面清单）

- ❌ 注释或分支里写「X 暂时不可用，所以先走 Y」——**"暂时"不能进代码**。
- ❌ 把某一次探测得出的顺序编成固定优先级链（例如"永远 global 优先，不行再 cn"）。
- ❌ 用"看似能排除"的开关代替真正的可用性判定（如 `PROVIDER_WEIGHT_FACTOR=0`
  期望排除某把 key，实际仍会被选中）。
- ❌ 把「某尺寸/某耗时必挂」写成硬阈值而不给 env 覆盖、不写取证时间。
- ❌ 在无 TTL 的缓存里存"上游能力"（catalog、健康账号、模型列表），让它永久生效。
- ❌ 依据单次压测结论调参（并发数、重试次数）就当成定论。

### 0.3 正确做法

1. **探测优先**：可用性来自运行时查询（catalog / 健康账号 / 最近一次成功记录），
   而不是来自常量。探测结果**必须带 TTL**，过期即重探。
2. **顺序来自证据**：优先级链由「刚刚验证过能服务的那一路」排第一；
   命中"池内无健康账号""该套餐无此模型"就**立即换另一路重试**，
   而不是等下一次 failover。
3. **一次观测 ≠ 事实**：单次探测只能得出"此刻"。要写进代码的经验，
   要么跨时间/多账号复验，要么落成**探针**（定时探测 + 动态打分）。
4. **阈值一律 env 可覆盖**，并在注释里写清：默认值是多少、依据哪次观测、
   什么条件下会失效。
5. **写进注释的结论要带日期与失效条件**，并在每次大改时复核一遍。
6. 宁可"每次多探一次"（几十毫秒），也不要"写死一个可能当天就反了的假设"。

### 0.4 本项目的真实教训（都是写死状态导致的）

| 当时写死的假设 | 后来的事实 | 后果 |
|---|---|---|
| 「cn 账号服务不了 deepseek 系，裸名永远先试 `global:`」 | 数小时后 global 池对该模型无健康账号，**cn 反而 200** | 连续 503，只能傻等 failover |
| 「cc 对 ~1MB 请求必挂 → 大 body 固定走本地 wb2api」 | 是当时的链路问题，不是恒定性质 | 会话中途换家，**prompt cache 全废** |
| 「`monthlyCredits` 耗尽等月度重置就好」 | 那是**预付余额**，重置不会变多 | 误判恢复时间，白等一晚 |
| 「oc 月度额度每天 02:33 重置」（写进定时任务说明） | 实际重置时刻随用量漂移（测到 09:47 / 01:57 / 02:18） | 值班判断出错 |
| 「MAX_RETRIES 调到 4 更稳」 | 一次并发测试下 4 反而 4/16，2 是 15/16 | 更差，且破坏既有测试语义 |

**共性**：每一条单看都"有证据"，问题是把**一次**观测固化成了**永久**规则。

### 0.5 提交前自检（5 问）

1. 我这次改的东西，是在描述**契约**还是在描述**此刻的状态**？
2. 如果上游明天表现相反，这段代码会怎样？会自愈，还是会卡死/走错？
3. 这个顺序/阈值/开关，**证据是哪来的、什么时候的**？写进注释了吗？
4. 能不能改成「探测 + TTL + 失败即换路」，而不是「固定 if」？
5. 这个值能不能用环境变量覆盖？默认值失效时有没有日志提示？

> 只要有一问答不上来，就不要把它写进代码——写成**探测**或**配置**。

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Build | `npm run build` |
| Type check | `npm run lint` (runs `tsc --noEmit`) |
| Run tests | `npx vitest run` |
| Setup wizard | `npm run setup` |
| Docker build | `npm run docker:build` |

## Running Tests

`npx vitest run` works from any invocation (terminal, VS Code, bash tool) — see "Vitest Hanging on Windows" below for the pool choice that makes this possible.

- `npx vitest run` — full suite (~7s, 582 tests)
- `npx vitest run src/proxy-logic.test.ts` — single file
- `npx vitest run -t "pattern"` — filter by test name
- VS Code launch configs are in `.vscode/launch.json`
- `tsc --noEmit` (`npm run lint`) works fine from the bash tool for type checking

### Test Structure

- `src/proxy-logic.test.ts` — Unit tests for proxy logic (49 tests)
- `test/e2e.test.ts` — E2E tests with real mock upstream + proxy servers (35 tests)
- `test/cli-setup.test.ts` — CLI setup wizard tests including smoke tests (46 tests)
- `test/global-teardown.ts` — Forces `process.exit(0)` after 1s to prevent Windows hanging

## Architecture

```
src/
  index.ts          — Entry point, starts the proxy server
  proxy.ts          — Hono app, middleware, request handling
  proxy-logic.ts    — Core failover/circuit-breaker logic (pure functions)
  config.ts         — YAML config loading and validation
  logger.ts         — Pino logger setup
  cli/
    setup.ts        — Interactive CLI setup wizard (exported for testing)
```

### Key Design Decisions

- **Config:** YAML (`config.yaml`), validated at startup. Backup created on re-setup.
- **Failover:** Round-robin across API keys with automatic fallback on errors.
- **Circuit breaker:** Per-key cooldown on 401/429/5xx. Lazy re-enable on next request.
- **Streaming:** Detects `text/event-stream` responses and pipes chunks with failover.
- **Token accounting:** Each forwarded response's `usage` (final SSE chunk for streams, top-level object otherwise) is booked per key label in `src/token-usage.ts` and persisted to `<config dir>/token-usage.json` with debounced atomic writes (mirrors `model-stats.ts`). Streaming requests get `stream_options.include_usage` injected when the provider advertises `supportsStreamUsage` and the client didn't set the option itself. Upstreams may repeat the same counts on several chunks (CommandCode: finish chunk + trailing usage-only chunk), so a stream is booked exactly once, preferring the usage-only chunk (`choices: []`).
- **Session headers:** `KeyProvider.sessionHeader` (OpenCode-Go: `x-opencode-session`, required live — 400 `MissingSessionID` otherwise) is forwarded when the client sends it and derived from the conversation (model + first user turn, system prompt excluded) when it doesn't. Body prep for one attempt happens in a single JSON pass (`prepareOutboundRequest` in `proxy.ts`).
- **Entitlement gating:** the usage refresh also classifies 403s that mean "account has no plan for this provider" (`src/usage-client.ts:isEntitlementError` — opencode-go `EntitlementError`, commandcode `upgrade_required`). Such keys get `entitled = false` in `ProxyState` (`setKeyEntitlement`) and are skipped by selection without touching the circuit breaker; a later refresh that returns usage flips them back. `/health` exposes `entitledCount`.
- **Key identification:** `oc_sk_…` is minted only by OpenCode-Go → definitive `yes` without a network probe; `user_…` → CommandCode; legacy `sk-…` is shared between providers, so it stays ambiguous and identification falls back to the live read-only smoke test. Validation, paste extraction and `inferProvider` accept all three prefixes.
- **Security:** CORS origin whitelist, HTTPS-only upstream, key filtering (min 20 chars; `oc_sk_`, `sk-` or `user_` prefix).
- **Rate limiting:** Via `hono-rate-limiter` middleware.

## Known Issues & Gotchas

### Windows Child Process Lifecycle

- `child.kill()` on Windows only kills `cmd.exe` (the shell wrapper), not the actual `npx tsx` child process. Orphaned processes keep the event loop alive.
- **Fix:** Use `taskkill /T /F /PID <pid>` to kill the entire process tree.
- `testProxy()` in `src/cli/setup.ts` uses `killProcessTree()` for this reason.

### Vitest Hanging on Windows

- Vitest's default `'forks'` pool hangs on Windows because tinypool fork workers don't shut down cleanly — they hold stdio pipes open, so the bash tool's pipe capture never returns.
- **Fix:** `pool: 'vmThreads'` in `vitest.config.ts` (runs tests in a VM context backed by `worker_threads`, no OS-level process boundary to leak handles). Verified: 582/582 tests pass in ~7s with no hang.
- **Also kept:** `globalSetup` with `teardown()` that calls `process.exit(0)` after 1s delay — belt-and-suspenders for the rare edge case.
- **Also:** `closeAllConnections()` on HTTP servers before `server.close()` to kill keep-alive sockets.
- `dist/` is excluded from vitest to prevent running tests twice (`.js` + `.ts`).

### testProxy Race Condition

- When polling `/health`, if a non-proxy server returns 200 with non-JSON body, `res.json()` throws.
- **Critical:** `started = true` and `clearTimeout()` must happen AFTER `await res.json()`, not before. Otherwise the timeout is cleared and the promise hangs forever.

### vi.mock() Hoisting

- Vitest hoists `vi.mock()` and `vi.hoisted()` to the top of the file regardless of where they're written.
- **Rule:** Always place them at the top level of the test file, not inside `describe` blocks.

### Temp Directory Cleanup on Windows

- `rmSync(tmpDir, { recursive: true, force: true })` can fail with EPERM if child processes still hold file handles.
- The smoke tests log a warning but don't fail — this is expected on Windows.

## Code Conventions

- ESM imports with `.js` extension: `import { foo } from './bar.js'`
- Export functions from `setup.ts` for testability (already done)
- No `any` unless absolutely necessary
- Prefer `const` over `let`
- Error messages should be descriptive for CLI output
- YAML config keys: `port`, `upstream`, `requestTimeoutMs`, `keys`, `allowedOrigins`

## Files NOT to Delete

These are gitignored but needed locally:
- `config.yaml` — Active proxy configuration
- `api_keys.txt` — API key reference
- `.codenomad/`, `.slim/` — Tool session artifacts
