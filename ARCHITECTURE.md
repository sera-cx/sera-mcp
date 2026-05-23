# Architecture

How `sera-mcp` is wired internally. For setup and usage, see [`README.md`](README.md). For threat model and hardening, see [`SECURITY-MODEL.md`](SECURITY-MODEL.md).

## Overview

`sera-mcp` is a stdio Model Context Protocol server. It exposes Sera Protocol's stablecoin FX rails — discovery, pricing, liquidity probing, quoting, execution, treasury, and history — as MCP tools, resources, and prompt templates. Every layer assumes the install instructions might be hostile and degrades gracefully when external dependencies are unavailable.

```
┌────────┐   sera.<tool>       ┌──────────────┐   POST /...        ┌──────┐
│ Agent  │ ──────────────────▶ │   sera-mcp   │ ─────────────────▶ │ Sera │
│ (host) │                     │  policy +    │                    │  API │
│        │ ◀─── result + meta  │  cache +     │ ◀──── response     │      │
└────────┘                     │  registry    │                    └──────┘
                               └──────────────┘
                                      │
                                      ├── external_fx (Frankfurter / open.er-api / exchangerate.host)
                                      └── persistence (optional SQLite)
```

## MCP surface

Three primitives are registered with the host:

### Tools (32)

Grouped by capability:

| Category | Tools |
|---|---|
| Discovery | `list_currencies`, `get_markets` |
| Pricing | `get_fx_rate`, `compare_to_external_fx`, `multi_source_mid`, `spread_radar` |
| Liquidity / analytics | `scan_markets`, `find_deals`, `probe_depth`, `round_trip_cost`, `infer_book`, `market_health`, `fx_quote_diff`, `compare_corridors`, `maker_quote_ladder` |
| Quote / planning | `get_quote`, `prepare_swap`, `quote_recipient_amount`, `find_cheapest_settlement_path`, `limit_watcher` |
| Treasury read / planning | `get_balances`, `treasury_value`, `exposure_report`, `rebalance_plan`, `pay_invoice`, `settlement_status` |
| History (requires `SERA_HISTORY_DB`) | `fx_history`, `fx_volatility`, `corridor_pnl` |
| Execution | `execute_swap`, `convert_and_send` |
| Admin | `doctor` |

Each tool has a Zod input schema (validated server-side before the handler runs) and returns a JSON-serialized result via MCP `content: [{ type: "text" }]`.

### Resources (5)

Read-only browseable state that hosts can pull without burning tool-call budget:

- `sera://currencies` — live token registry snapshot
- `sera://markets` — live trading-pair catalog
- `sera://config` — server config + signer mode + policy summary
- `sera://help/tools` — tool catalog with usage hints
- `sera://help/quickstart` — minimal first-call recipes

### Prompts (4)

Slash-prompt templates with sanitized args:

- `sera.deal_scan` — opinionated wrapper around `find_deals`
- `sera.treasury_brief` — multi-wallet exposure + rebalance suggestion
- `sera.invoice_optimizer` — cheapest-path picker across source assets
- `sera.fx_integrity_check` — multi-source mid + spread radar + bias check

Every prompt arg is validated by `src/util/sanitize.ts` (address regex, fiat regex, numeric regex, symbol regex) before substitution into the LLM message body. Newline / SQL / instruction-injection payloads are rejected at the boundary.

## Signer modes

| Mode | Behavior | Use case |
|---|---|---|
| `external` (default) | Server holds no key. `get_quote` returns `route_params` (EIP-712 Intent). Caller signs externally. `execute_swap` accepts the signature. | Safe for distribution. Default for any shared install. |
| `local` | Server holds `SIGNER_PRIVATE_KEY` and signs `route_params` in-process. Enables `convert_and_send`. | Trusted single-operator deployments with intentionally funded wallets. |
| `readonly` | All execution tools refuse. Discovery + analytics only. | Public read-only deployments. |

Source: [`src/signer/signer.ts`](src/signer/signer.ts).

## Policy engine

Pre-trade gates run before the Sera REST client is ever called. Configured via env or a `POLICY_PRESET` bundle:

- **Symbol whitelist** — only allow specified token symbols as input or output.
- **Recipient whitelist** — restrict `recipient` addresses on `execute_swap` / `convert_and_send`.
- **Per-tx notional cap** — reject quotes above `POLICY_MAX_NOTIONAL_USD`.
- **Daily volume cap** — rolling 24h `route_params.maxInputAmount × token USD value` ≤ `POLICY_DAILY_VOLUME_CAP_USD`. Server-derived (caller cannot lie).
- **Extra slippage cap** — `POLICY_EXTRA_SLIPPAGE_BPS` on top of Sera's quote.
- **Dry-run** — `POLICY_DRY_RUN=true` causes every `execute_swap` to refuse regardless of signer mode.

Source: [`src/policy/policy.ts`](src/policy/policy.ts).

## Quote registry

Every `get_quote` registers `{uuid → frozen route_params + computed USD notional}` in memory. `execute_swap` enforces:

- **In local-signer mode**: the uuid MUST have been issued by this server; otherwise refuse.
- **In any mode**: the caller-supplied `route_params` MUST match the registered binding byte-for-byte; otherwise refuse.

This prevents a malicious caller from asking the local signer to sign an arbitrary intent, and prevents a caller from mutating route_params (e.g., reducing `minOutputAmount`) between quote and execute.

Source: [`src/util/quote_registry.ts`](src/util/quote_registry.ts).

## Sera REST client

Wrapped HTTP client (undici) with:

- **Hardcoded base URLs** by network in `src/config.ts` (`NETWORK_URLS` map). `SERA_BASE_URL` is ignored unless `SERA_BASE_URL_ALLOW_CUSTOM=true` is also set.
- **Redirect refusal** — `maxRedirections: 0`. Even a sera.cx subdomain cannot 301 the client elsewhere.
- **TTL cache + in-flight de-dupe** on read endpoints: tokens 5min, markets 10min, config 1h, fx_rate 60s, system_time 5s.

Source: [`src/sera/client.ts`](src/sera/client.ts), [`src/util/cache.ts`](src/util/cache.ts).

## Execution flow (external signer)

```
1. agent → sera.get_quote { from, to, amount, owner_address }
2. mcp   → POST /swap/quote → Sera
3. Sera  ← uuid + route_params (EIP-712 Intent)
4. mcp   ← register {uuid → route_params + notional}
5. mcp   → agent: { uuid, route_params, ... }
6. agent → wallet: signTypedData(domain, types, route_params)
7. wallet ← signature
8. agent → sera.execute_swap { uuid, signature }
9. mcp   ← verify (uuid known + route_params unchanged + daily-cap ok + not dry-run)
10. mcp  → POST /swap → Sera → on-chain settlement
```

Quotes are single-use. On `QUOTE_STALE` / 410, re-quote — do not retry the same `uuid`.

## File layout

```
src/
├── index.ts                  MCP server entrypoint + tool/resource/prompt registration
├── cli.ts                    `sera` CLI (same handlers as MCP, different transport)
├── config.ts                 env loading, hardcoded URL allowlist, AppContext
├── resources.ts              MCP resources (sera://...)
├── prompts.ts                slash-prompt templates with arg sanitization
├── sera/
│   ├── client.ts             REST client + TTL cache wrapper
│   ├── tokens.ts             token resolver, decimals math
│   └── types.ts
├── signer/signer.ts          EIP-712 signer (external | local | readonly)
├── policy/policy.ts          whitelist, caps, presets, dry-run, daily volume gate
├── tools/                    32 tool handlers across 10 modules
└── util/
    ├── cache.ts              TTL cache + in-flight de-dupe
    ├── env.ts                env parsing helpers
    ├── limit.ts              bounded-concurrency runner
    ├── external_fx.ts        Frankfurter / open.er-api / exchangerate.host
    ├── persistence.ts        optional SQLite log
    ├── logger.ts             structured stderr JSON
    ├── quote_registry.ts     uuid → route_params binding
    ├── sanitize.ts           prompt arg validators
    └── zod-to-json.ts        Zod → MCP JSON Schema bridge
```

## Logging

Structured JSON to stderr only. Stdout is reserved for MCP transport. Levels via `LOG_LEVEL`: `trace` | `debug` | `info` (default) | `warn` | `error`.

Source: [`src/util/logger.ts`](src/util/logger.ts).

## Optional persistence

When `SERA_HISTORY_DB=/path/to/file.db` is set, every fx_rate observation and quote call is logged to local SQLite. Powers `fx_history`, `fx_volatility`, `corridor_pnl`. Over time the MCP becomes its own price feed for the corridors it sees.

Source: [`src/util/persistence.ts`](src/util/persistence.ts).
