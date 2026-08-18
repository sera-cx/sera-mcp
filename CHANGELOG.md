# Changelog

All notable changes to `sera-mcp` are documented in this file. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — tools ported from `sera-mcp-v2` (55 → 57 tools)
`sera-cx/sera-mcp-v2` is a standalone single-file prototype, not a successor to this
package. Both talk to the same `/api/v1` surface, and this server's endpoint coverage
is a superset (26 paths vs 10), so its only real contribution was a few tools that had
no equivalent here. Those are now ported and v2 can be retired.

- `sera.get_trading_pairs` (`src/tools/core.ts`) — every market a single token can route
  through, with the side (ASK/BID) you'd trade to leave it. Token-centric view of
  `/markets` that `sera.get_markets` (whole catalog) doesn't provide. Unlike v2's version
  it takes any reference `resolveToken` understands — symbol, 0x address, or fiat tag —
  not just a raw address, and reuses the existing 10-min markets cache (no new endpoint).
- `sera.get_wallet_info` (`src/tools/admin.ts`) — signer mode, resolved taker address,
  and whether execution tools are exposed. `sera.doctor` reports signer *mode* but never
  the resolved address, and costs several API round-trips; this is local-only. Returns
  `address: null` in external/readonly mode, which is the correct answer rather than an
  error. Deliberately omits v2's `balance_eth` field: v2 held an RPC URL and a private
  key, this server holds neither by default, and adding an RPC dependency to report gas
  would undo the external-signer posture.
- `test/ported-tools.test.ts` (9 tests, 111 → 120) — direction/ASK/BID invariants, all
  three token-reference forms, empty-vs-unknown-token distinction, and `get_wallet_info`
  across all three signer modes including signer failure and the no-gas-balance guarantee.

### Added — structured output for the discovery surface (4 → 10 tools with `outputSchema`)
`create-server.ts` emits `structuredContent` whenever a tool declares an `outputSchema`,
and the MCP SDK **validates** that payload against the schema. That makes schema drift a
runtime failure for every caller, not a soft degradation — so the rollout is deliberate
and test-guarded rather than bulk-generated.

- `GetMarketsOutput`, `GetTradingPairsOutput`, `GetWalletInfoOutput`, `SearchCoinsOutput`,
  `GetCoinMetadataOutput`, `GetCoinHistoryOutput` — all 8 `discovery` tools now declare
  structured output. `get_coin_metadata` (2 return shapes) and `get_coin_history` (4)
  are modelled as one permissive object each with optional fields, so every branch
  validates without a discriminated union that hosts would flatten anyway.
- All new schemas are `.passthrough()`. A strict object rejects unknown keys, so a
  handler that later grows a field would start erroring for every caller. The 4 pre-existing
  v0.7.0 schemas are unchanged.
- `test/output-schemas.test.ts` (10 tests, 120 → 130) — parses each schema against the
  handler's **actual** output, covering the not-found / history-disabled / untagged-token
  branches and a token with no `name` or `fiat_currency`. Two registry invariants lock the
  rollout in: every `discovery` tool must declare an `outputSchema`, and the set of strict
  (non-passthrough) schemas may never grow.
- Verified end-to-end: `createServer()` registers all 56 default-mode tools with the new
  schemas, confirming Zod → JSON Schema conversion succeeds for every one.

### Not ported
- **v2's `get_clob_swap_quote`** — not a distinct CLOB path despite the name. It POSTs the
  same `/swap/quote` endpoint with the same body shape this server's `sera.get_quote`
  already uses (`SwapQuoteRequest`), minus `gas_mode`. Adding it would be a duplicate tool
  for zero new capability.
- **v2's one-shot `execute_deposit` / `execute_withdraw` and auto-broadcast approve inside
  `execute_swap`** — a design conflict, not a gap. This server deliberately splits
  build → sign → send (`build_deposit` + `send_tx`, and the 3-step dual-sig withdraw flow)
  because the default is `SERA_SIGNER_MODE=external` with no key on disk. v2's one-shot
  flow requires the server to hold a private key. If wanted, these belong behind the same
  local-signer gate as `convert_and_send`, not as unconditional tools.

### Changed — docs / defaults reconciled to the live 55-tool surface
- `SERVER_VERSION` in `src/server/create-server.ts` aligned to **0.8.3** (was still advertising 0.8.2 in the MCP handshake).
- README / ARCHITECTURE / CONTRIBUTING: tool count **32 → 55**, full category table matching `src/tools/registry.ts`, and accurate smoke-test expectation (**54** under default `external` signer because `convert_and_send` is local-only).
- `sera://help/tools` resource (`src/resources.ts`): count **51 → 55**, added missing coin / health / corridor tools so the in-MCP catalog matches the registry.
- `.env.example`: removed misleading `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` block — this package is not an LLM client.
- Org links updated `Josh-sera/*` → `sera-cx/*` (README, CONTRIBUTING, SECURITY*, CODE_OF_CONDUCT, maker_orders comment).
- `SECURITY-MODEL.md` x402 note aligned with current `sera-agents` model (CDP facilitator wired; `X402_LIVE_ACK` / Sepolia E2E still the gate) — no longer calls live verify a “scaffold.”

## [0.8.3] — 2026-05-25

### Changed
- `src/config.ts` — `SERA_NETWORK=sepolia` now resolves to `https://api-testnet.sera.cx/api/v1`. The previous host (`api-sepolia.sera.cx`) does not resolve in DNS; testnet runs against the canonical `api-testnet.sera.cx` endpoint serving Sepolia (chain_id 11155111).
- `README.md` — env-var table updated to match.

### Verified
- `api-testnet.sera.cx` `/health` returns `signature_ready: true`; `/config` returns `chain_id: 11155111` with Sera/Vault/SOR contracts and EIP-712 domain populated.

## [0.8.2] — 2026-05-24

### Added — test coverage on new code (81 → 109 tests)
- `test/registry.test.ts` (17 tests) — meta-tests over the tool registry: unique names, sera.* prefix, every tool has annotations + inputSchema + handler, allowed category set, destructive flag invariants (KNOWN_DESTRUCTIVE list of 10 tools), readOnly + destructive mutual exclusion, execution + maker category coverage, outputSchema-tagged tools have parseable Zod schemas, the 4 v0.7.0-migrated tools (doctor, list_currencies, get_fx_rate, market_health) still have outputSchema.
- `test/http-guard.test.ts` (11 tests) — `publicBindGuardDecision` extracted as pure function and tested across localhost variants, 0.0.0.0/public-IP refusal without allowedHosts, allowedHosts allow-path, ack env case-insensitivity, empty allowedHosts array doesn't satisfy the gate.

### Changed
- `src/transports/http.ts`: extracted `publicBindGuardDecision` as a pure exported function. `enforcePublicBindGuard` is now a thin wrapper that pulls the env + handles process.exit. Pure form is testable in isolation.

### Notes
- 109 tests pass in ~370ms. No production behavior change — pure test coverage + one refactor for testability.

## [0.8.1] — 2026-05-24

### Added — public-bind startup guard
- New env: `SERA_HTTP_ALLOW_UNAUTHENTICATED_PUBLIC`. When the HTTP transport binds to a non-loopback host (anything other than `127.0.0.1` / `localhost` / `::1`) without `--allowed-hosts`, the server refuses to start unless this env is explicitly set to `true`.
- Boot error message lists the three safe options: localhost bind, allowed-hosts allowlist (assumes auth reverse proxy in front), or explicit unsafe acknowledgment.
- Host-header validation via `--allowed-hosts` is NOT authentication — it just stops cross-origin browser-borne DNS-rebinding. The guard makes that distinction loud.

### Fixed — docs out of sync (the actual reason for this release)
- `SECURITY-MODEL.md` no longer says Streamable HTTP is "planned, not implemented" — replaced with the full v0.8.0 hardening status + deployment matrix.
- `README.md` HTTP section now carries a top-of-section blockquote warning instead of a single trailing paragraph. Three numbered safe-deployment options. Cross-references to SECURITY-MODEL.md for the matrix.

### Verified
- 81 tests pass.
- Public-bind guard: `--host 0.0.0.0` without `--allowed-hosts` refuses with clear message.
- `--host 0.0.0.0 --allowed-hosts test.local` boots cleanly; `/health` responds with matching `Host: test.local` header.

## [0.8.0] — 2026-05-24

### Added — Streamable HTTP transport
- New `--transport http` flag (default remains `stdio`). Opt-in for remote/web-served agent hosts (ChatGPT connectors, hosted multi-tenant, web-chat backends).
- New env: `SERA_TRANSPORT`, `SERA_HTTP_HOST` (default `127.0.0.1`), `SERA_HTTP_PORT` (default `3848`), `SERA_HTTP_ALLOWED_HOSTS` (comma-separated), `SERA_HTTP_STATELESS`.
- DNS-rebinding protection automatically enabled when binding to `127.0.0.1` / `localhost` / `::1` (via `createMcpExpressApp`). For non-localhost binds, pass `--allowed-hosts` to restrict by `Host` header.
- Endpoints: `POST /mcp` (JSON-RPC), `GET /mcp` (SSE stream for stateful notifications), `DELETE /mcp` (session terminate), `GET /health` (liveness probe).
- Stateful sessions by default (random session ID). `--stateless` for serverless / Cloudflare-Workers-like deploys.
- Stdio path unchanged — existing Claude Code / Desktop / Cursor registrations keep working.

### Added — new files
- `src/transports/stdio.ts` — extracted stdio attach.
- `src/transports/http.ts` — Streamable HTTP attach with DNS-rebinding protection.

### Added — dependency
- `express ^4.21.0` (runtime; required by `createMcpExpressApp`).
- `@types/express ^4.17.0` (dev).

### Not yet shipped
- **OAuth 2.1 + RFC 8707 Resource Indicators** for public/multi-tenant deployment (per MCP spec v2025-06-18). HTTP transport today is safe for localhost binding or behind a trusted reverse proxy. Public exposure without OAuth would mean any caller can invoke any tool — explicitly out of scope for v0.8.0.
- **Read/exec endpoint split** (`/mcp/read`, `/mcp/exec`) — lands with OAuth so each surface can have its own scope.

### Verified
- `--transport http` boots clean, returns proper `serverInfo` on initialize, /health responds, DNS-rebinding protection logs as enabled on default 127.0.0.1 bind.
- Stdio transport unchanged: 51 tools listed identically.
- 81 tests still pass.

## [0.7.0] — 2026-05-24

### Added — maker / order-book tools (9 tools, 42 → 51 total)
- `sera.place_order` — submit a signed limit order. Agent picks client-side `order_id` (UUID4) so POST /orders is idempotent. Returns `{ order_id }`.
- `sera.cancel_order` — signed cancel via composite `uuid_int`. 5-min per-order cooldown.
- `sera.cancel_all_orders` — bulk kill-switch. Returns `cancelled` / `failed` / `skipped_cooldown` lists.
- `sera.place_vl_batch` — 2-50 signed orders sharing one collateral pool. Matching engine freezes only the largest single-leg cost, not the sum. Validates sibling-owner + sibling-fromToken at the boundary.
- `sera.cancel_vl_batch` — cancel a whole VL batch by `vl_batch_id`.
- `sera.get_order` — single order with full `settlement_summary` + `settlement_economics`.
- `sera.list_orders` — rich filter surface (status / type / symbol / side / token / price / amount / notional / time / sort). `limit` max 500.
- `sera.get_fills` — fills across orders with per-fill `settlement_economics`.
- `sera.get_fills_for_order` — fills for one specific order.

New tool category: `maker`. The MCP forwards signed payloads as-is; the agent constructs `uuid_int` and signs Order / CancelOrder / CancelVLBatch structs under the Sera EIP-712 domain. Server-side maker signing for local-signer mode is planned for a future release.

### Added — doctor enrichment
`sera.doctor` now surfaces three additional checks:
- `contracts` — live `sera_address`, `vault_address`, `sor_address` from `/config` (use these for any signed payload; addresses can drift between deployments).
- `vl_batch_limits` — live `min` / `max` from `/config → limits.vl_batch`. Don't hardcode the cap.
- The existing `network_sanity` and `executor_id` checks also moved to read from `liveCfg` once instead of fetching twice.

### Added — `outputSchema` + `structuredContent` (incremental migration)
Set on 4 tools to establish the pattern:
- `sera.doctor` → `DoctorOutput` (overall_ok + checks[])
- `sera.list_currencies` → `ListCurrenciesOutput`
- `sera.get_fx_rate` → `FxRateOutput`
- `sera.market_health` → `MarketHealthOutput`

When a tool has `outputSchema`, the MCP response emits `structuredContent` alongside the human-readable text. Hosts that validate/render structured output use it; agents without structured-content support fall back to text seamlessly. Migration to full coverage is incremental — remaining tools planned across v0.7.x patches.

### Updated — `sera://help/tools` resource
Reflects the full 51-tool surface (was 32). New sections for account/funds, withdraw, maker, debugging.

### Notes
- 81 tests still pass after additions.
- `tools/call sera.doctor` verified emitting `structuredContent` with 9 checks (was 6 in v0.5.x).

## [0.6.0] — 2026-05-24

### Added — 11 new tools (32 → 42 total)

**Account / funds (5 destructive tools, all API-Key gated):**
- `sera.build_approve` — build unsigned ERC-20 `approve()` tx (sign locally, broadcast via `send_tx`).
- `sera.build_deposit` — build vault deposit tx, optionally with EIP-2612 permit (combines approve+deposit in one tx).
- `sera.build_transfer` — build unsigned ERC-20 `transfer()`.
- `sera.send_tx` — broadcast a locally-signed approve/deposit raw_tx.
- `sera.send_transfer` — broadcast a locally-signed transfer raw_tx.

**Withdraw (3 tools — 4-step dual-sig flow):**
- `sera.withdraw_request` — step 1: user signs `WithdrawIntent`; this returns the executor co-signature.
- `sera.withdraw_build` — step 2: returns the unsigned `executeInstantWithdrawDualSig` tx given both signatures.
- `sera.withdraw_send` — step 4: broadcast the locally-signed raw_tx (step 3 is the user signing locally).

**Debugging / helpers (3 tools):**
- `sera.batch_quote` — wraps `POST /swap/quote/batch` (up to 50 quotes per round-trip). Replaces client-side fan-out for `scan_markets` / `find_deals` workflows. Per-item errors surface inline without failing the batch.
- `sera.verify_signature` — wraps `POST /verify-signature`. Test an EIP-712 signature without burning a quote.
- `sera.permit_metadata` — wraps `GET /permit/metadata`. Returns whether a token supports EIP-2612 + nonce + current allowance.

### Added — new tool categories
`account`, `withdraw`, `debugging` join the existing 7 categories. The `execution` opt-in gate (`SERA_ENABLE_EXECUTION_TOOLS`) does NOT cover account or withdraw — those have their own signer/auth requirements at the call boundary.

### Added — SeraClient methods
`postSwapQuoteBatch`, `verifySignature`, `getPermitMetadata`, `buildApprove`, `buildDeposit`, `buildTransfer`, `sendTx`, `sendTransfer`, `withdrawRequest`, `withdrawBuild`, `withdrawSend`. Plus typed response shapes (`BuildTxResponse`, `TxSendResponse`, `WithdrawCosignResponse`, `VerifySignatureResponse`, `PermitMetadataResponse`, `BatchQuoteResponse`) in `src/sera/types.ts`.

### Added — `SeraConfig` typed fields
`domain_separator`, `eip712_domain`, `limits.vl_batch` now typed (was `[k: string]: unknown` pass-through).

### Notes
- All tx builders are API-Key gated. The matching `send_*` tools are flagged `destructive: true` and require API Key.
- Withdraw step 1 (`withdraw_request`) and step 2 (`withdraw_build`) can run without an API Key (intent + sig is the auth); step 4 (`withdraw_send`) likewise.
- 81 tests still pass after the additions. No new test coverage on the new tools yet — Sprint 1B+ would extend it.

## [0.5.2] — 2026-05-24

### Added
- **Vitest test suite — 81 tests across 5 files.**
  - `test/sanitize.test.ts` (30 tests) — every prompt-arg validator: injection rejection, fallback semantics, case handling.
  - `test/quote_registry.test.ts` (12 tests) — register/lookup, auto-expiry, `routeParamsMatch` against tampered minOutputAmount / recipient / uuid, missing-field detection, string-coerced uuid comparison.
  - `test/policy.test.ts` (23 tests) — symbol/recipient whitelists (incl. EIP-55 vs lowercase), dry-run kill switch, per-tx notional cap with non-USD FX conversion, daily volume cap, preset shape, fiat-from-symbol guess.
  - `test/client-helpers.test.ts` (11 tests) — `parseRetryAfter` (integer seconds, HTTP-date, cap, negatives, garbage, array-form header) + `lowerOwner` normalization.
  - `test/cache.test.ts` (5 tests) — TTL expiration, in-flight de-dupe, errors-not-cached, key independence.
- `tsconfig.test.json` so tests typecheck without breaking build's `rootDir` constraint.
- `npm run test` + `test:watch` scripts. CI runs tests on every push/PR. `npm run check` now includes tests.

### Changed
- `parseRetryAfter` and `lowerOwner` exported from `src/sera/client.ts` for direct unit-testing.

### Notes
- All 81 tests run in ~250ms locally; vitest pool=threads.
- No behavior change for users — tests lock in the v0.5.1 P0 fixes against regression.

## [0.5.1] — 2026-05-24

### Fixed (correctness)
- **`execute_swap` now accepts `permit_signature` + `permit_deadline`.** When `/swap/quote` returns a non-null `permit` envelope (wallet-funded swap on EIP-2612-supported token), Sera's `POST /swap` requires these fields. Previously sera-mcp dropped them, causing wallet-funded permit-token swaps to fail with `ALLOWANCE_INSUFFICIENT`. Vault-funded swaps were unaffected.
- **`get_quote` now surfaces the `permit` envelope** in its response. Callers can sign `permit.eip712` and pass `permit_signature` + `permit_deadline` to `execute_swap`. Null permit = either vault-funded or permit-unsupported token (use approve flow).
- **`owner_address` is now lowercased on read endpoints** (`/balances`, `/orders`). Sera docs: "Read endpoints treat `owner_address` as case-sensitive; use lowercase form." EIP-712 signed payloads still accept EIP-55 checksum. Previously checksummed addresses passed to `get_balances` could 4xx.
- **HTTP client honors `Retry-After` on 503 for GET requests** (max 2 retries, cap 5s). Per Sera docs, "Server failures (5xx) mapped to 503 with Retry-After: 1 header." POSTs are never auto-retried (could double-execute). Transient Sera blips no longer hard-fail reads.

### Added
- `doctor` now surfaces `executor_id` from `/health` as its own check. Mainnet default is `0`; drift invalidates outstanding signed `uuid_int` values.

### Docs
- `PolicyConfig` JSDoc now explicitly distinguishes conventional bps (denom 10⁴, used by `outputToleranceBps`) from Sera's contract `BPS_DENOMINATOR` (10¹⁴, used by `Order.feeBps` once maker tools land in v0.7.0).
- `SECURITY-MODEL.md` audit finding #2 (Bearer concat) status changed from "Open (Sera-side spec issue, escalated upstream)" to "Documented Sera spec — non-standard for Bearer but intentional per docs.sera.cx".

### Notes
- No tool-surface change for current users beyond the new optional permit fields. All 32 tools work identically when `permit_signature` is unset.

## [0.5.0] — 2026-05-24

### Added
- `ARCHITECTURE.md` — internal wiring, MCP surface, signer modes, policy engine, quote registry, execution flow, file layout.
- `SECURITY-MODEL.md` — structured threat model, safe defaults, execution risks, local-signer risks, transport risks (current vs planned), not-production-ready disclosures, recommended deployment settings, audit-findings status.
- `CHANGELOG.md` (this file).
- `npm run audit` and `npm run check` scripts.
- README **Status** section with explicit Stable / Operator-managed / Planned labels per surface.
- README **Who this is for** line; companion-repo cross-link; deeper-reading pointers.
- **MCP modernization**: `McpServer` + `registerTool` API across all 32 tools. Every tool now carries `title`, `annotations` (`readOnly` / `destructive` / `idempotent` / `openWorldHint`), and a `category` tag (`discovery` / `pricing` / `liquidity` / `quote_planning` / `treasury` / `history` / `execution`). Host runtimes can now reason about which tools are safe to auto-call vs which need explicit user confirmation.
  - `convert_and_send` and `execute_swap` are now flagged `destructive: true` at the protocol level.
- New `src/server/create-server.ts` (server construction) and `src/tools/registry.ts` (single source of truth for tool definitions). `src/index.ts` reduced to bootstrap only.

### Changed
- Upgraded `@modelcontextprotocol/sdk` to `^1.18.0` (was `^1.0.4`).
- Added `overrides` block (`qs ^6.15.2`, `ws ^8.21.0`) to clear moderate audits via the dependency tree.
- Modularized server build: tool registry split into `src/tools/registry.ts`; server creation into `src/server/create-server.ts`. Behavior unchanged for callers (same tool names, same input schemas, same return shape).

### Fixed
- Audit: 0 vulnerabilities (was 3 moderate via `ethers → ws` and `qs`).
- README: corrected stale "29 tool handlers" → 32.

### Added (also)
- **`SERA_ENABLE_EXECUTION_TOOLS` env flag** (default `true`). When set to `false`, the `execution` tool category (`execute_swap`, `convert_and_send`) is NOT registered with the MCP host — discovery, pricing, liquidity, quote planning, treasury, and history tools all keep working. Use for public/multi-tenant deployments where execution should be hidden behind a separate auth surface.
- `convert_and_send` is now only registered when `SERA_SIGNER_MODE=local`. Previously surfaced as a tool that always failed under `external`/`readonly`; now correctly hidden.

### Notes
- `outputSchema` + `structuredContent` are NOT YET added per-tool. Planned for v0.5.1 — adds machine-readable result shapes for hosts that want to validate or render tool output.
- Streamable HTTP transport remains on the roadmap, gated on remote-deployment product decisions. Stdio behavior is unchanged in this release.
- **Default behavior is preserved**: `SERA_ENABLE_EXECUTION_TOOLS` defaults to `true`, so existing Claude Code / Desktop / Cursor registrations continue to see all 32 tools (or 31 when running under `external` signer mode, since `convert_and_send` now properly self-hides).

## [0.4.0] — 2026-05-13

- Added `market_health` (yes/no quotability probe), `fx_quote_diff` (reference vs executable rate diff), `compare_corridors` (rank source currencies for a target output). 32 tools total.

## [0.3.3] — 2026-05-13

- **Security hardening**: URLs hardcoded by network in `src/config.ts` (`NETWORK_URLS` map). `SERA_BASE_URL` is ignored unless `SERA_BASE_URL_ALLOW_CUSTOM=true` is also set. Default install needs zero env vars; `SERA_NETWORK=mainnet|sepolia` switches between canonical URLs.

## [0.3.2] — 2026-05-13

- **Security**: undici `maxRedirections: 0` prevents 30x escape from sera.cx subdomain.

## [0.3.1] — 2026-05-13

- **Security**: uuid binding (quote registry refuses unknown uuids in local mode + route_params mismatch in any mode).
- **Security**: server-derived USD notional (caller can no longer spoof `estimated_usd_notional`).
- **Security**: prompt arg sanitization (typed validators reject newline/SQL/instruction-injection payloads before LLM substitution).

## [0.3.0]

- TTL cache + in-flight de-dupe on read endpoints. Bounded-concurrency runner for scan/probe tools. Structured stderr JSON logger.
- 5 MCP resources + 4 slash-prompt templates.

## [0.2.0]

- First public-facing release. stdio MCP server with policy presets, signer modes, external FX comparison via Frankfurter.
