# Changelog

All notable changes to `sera-mcp` are documented in this file. Versions follow [Semantic Versioning](https://semver.org/).

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
