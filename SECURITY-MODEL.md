# Security Model

For vulnerability reporting, see [`SECURITY.md`](SECURITY.md). For architecture, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Threat model

`sera-mcp` is designed for distribution. The default install will be run by people who copy a one-liner from a README without auditing the source. Every layer assumes:

- The install instructions might be hostile.
- The agent that ends up calling `sera-mcp` might be coerced via tool-poisoning or prompt injection from third-party tool responses in the same agent context.
- Network egress is untrusted (MITM, hostile DNS, hostile facilitator).
- The caller might be a hostile process running on the same machine in stdio mode.

What is NOT in the threat model:

- A compromised local OS (if the box is rooted, no userspace policy gate matters).
- A compromised Sera upstream (mitigated by external-source FX comparison, but not solved here).
- An unbounded LLM coerced into approving every action (mitigated by execution opt-in + policy caps + `POLICY_DRY_RUN`, but ultimately the host runtime owns confirmation UX).

## Safe defaults

A fresh `npm install && node dist/index.js` with no env vars set is intentionally safe:

| Default | Effect |
|---|---|
| `SERA_NETWORK=mainnet` | Hardcoded URL `https://api.sera.cx/api/v1`. Cannot be redirected via env. |
| `SERA_SIGNER_MODE=external` | Server holds no private key. Cannot sign anything. |
| `POLICY_PRESET=standard` (when set) | Symbol whitelist, $5k per-tx, $50k daily cap, 10 bps slippage. |
| `POLICY_DRY_RUN=false` | But every execute path is opt-in via signer mode. |
| `maxRedirections: 0` | Cannot follow 30x to off-domain hosts. |
| Stdout reserved for MCP transport | Logs to stderr only; no spoofed protocol messages possible. |

## Boundary defenses

### Base URL hardening

`src/config.ts` contains a `NETWORK_URLS` map with canonical Sera API URLs per network. `SERA_BASE_URL` is **ignored** unless `SERA_BASE_URL_ALLOW_CUSTOM=true` is also set. A malicious install snippet would need to slip in two env vars (one loudly named `_ALLOW_CUSTOM`) to redirect API traffic.

### Quote registry

Every `get_quote` registers `{uuid → frozen route_params + USD notional}`. `execute_swap` refuses:

- Unknown uuids in local-signer mode (won't sign arbitrary intents).
- Caller-supplied `route_params` that don't match the registry binding (prevents post-quote tampering).

### Server-derived notional

The daily volume cap is computed server-side from `route_params.maxInputAmount × token USD value`. Caller-supplied `estimated_usd_notional` is no longer used — it cannot be spoofed to bypass the cap.

### Prompt arg sanitization

Every slash-prompt template arg is validated with typed regex before substitution:

- Ethereum address regex (`^0x[a-fA-F0-9]{40}$`)
- ISO fiat regex (`^[A-Z]{3}$`)
- Numeric regex (no scientific notation, no negative)
- Symbol-list regex (comma-separated uppercase tokens)

Newline / SQL / instruction-injection payloads are rejected with `prompt arg "X" rejected (...)` errors **before** reaching the LLM message body. Source: [`src/util/sanitize.ts`](src/util/sanitize.ts).

## Execution risks

### Local signer mode

`SERA_SIGNER_MODE=local` means the server can sign EIP-712 Intents in-process with the wallet behind `SIGNER_PRIVATE_KEY`. This unlocks `convert_and_send` and lets `execute_swap` accept a uuid alone (server signs).

**Risks:**

- Anyone with stdio access to the MCP process can request a quote and execute. There is no per-call user confirmation.
- If `SIGNER_PRIVATE_KEY` leaks (env exposure, log spill, process memory dump), the wallet is fully compromised.
- If the policy preset is overly permissive (`open`) and a hostile agent gets stdio access, drainable.

**Mitigations to apply when running local mode:**

- Use a wallet you've **intentionally** funded with a working balance — never a hot wallet of meaningful value.
- Set a tight `POLICY_PRESET` (`starter` or stricter).
- Set `POLICY_DAILY_VOLUME_CAP_USD` to the smallest value that works.
- Set `POLICY_ALLOWED_RECIPIENTS` to a whitelist if you only pay known counterparties.
- Run on a host that no untrusted process can attach to.
- Keep `LOG_LEVEL=info` or `warn` so transient state doesn't leak into logs.

### External signer mode (default)

The agent host owns the signing UX. The MCP **never** sees the private key. Risks are pushed to the host:

- The host must surface `route_params` to the user for confirmation before signing (this is a host-runtime concern, not an MCP one).
- A malicious agent could craft requests to extract many `route_params` hoping the user signs one. The quote registry + policy caps blunt this; the host's confirmation UX is the real gate.

### `convert_and_send`

This tool is `destructive` — it quotes + executes + transfers in one call. Requires `SERA_SIGNER_MODE=local`. It is documented as opt-in. A future release will add `SERA_ENABLE_EXECUTION_TOOLS` to require an explicit env flag before this tool (and `execute_swap`) is even registered with the MCP host.

## Transport risks (current vs future)

### stdio (current)

`sera-mcp` currently runs over stdio. Risks:

- Any local process that can write to the MCP's stdin can call any registered tool. Trust boundary = local OS user.
- No authentication or rate limiting at the MCP layer (relies on host runtime).

### Streamable HTTP (planned, not implemented)

When added, every HTTP-exposed install will require:

- DNS rebinding protection via `createMcpExpressApp()` Host header validation.
- Read/exec endpoint split (`/mcp/read`, `/mcp/exec`).
- OAuth 2.1 Resource Server pattern with RFC 8707 resource indicators for any remote/multi-tenant deployment.
- `Cache-Control: no-store` on any future paid/gated endpoints.

These hardenings are NOT YET shipped. Do not expose `sera-mcp` over HTTP today.

## x402 / payment risks

`sera-mcp` itself has no x402 payment surface. The companion repo [`sera-agents`](https://github.com/Josh-sera/sera-agents) ships an x402 service (`x402-service/`) whose live-mode `verifyPayment` is intentional scaffold and is **not production-complete**. See `sera-agents/SECURITY-MODEL.md` for the x402 threat surface.

## Not production-ready (today)

Explicit list of items that look ready but are not:

- **Streamable HTTP transport**: not implemented. Don't run `sera-mcp` over HTTP today.
- **Remote multi-tenant deployment**: no OAuth 2.1 / no per-tenant policy. Single-tenant only.
- **x402-service live mode** (in `sera-agents`): stub verification; replace before going live.
- **Per-tool rate limiting**: not implemented. `limit_watcher` polls unrate-limited at the MCP layer.
- **Sanctions / address risk screening**: no built-in OFAC check on `recipient`. Use `POLICY_ALLOWED_RECIPIENTS` whitelist.

## Recommended deployment settings

### Local dev (running the MCP for your own agent)

```bash
SERA_NETWORK=mainnet
SERA_SIGNER_MODE=external
POLICY_PRESET=standard
POLICY_DRY_RUN=false
LOG_LEVEL=info
```

### Trusted single-operator with local signing

```bash
SERA_NETWORK=mainnet
SERA_SIGNER_MODE=local
SIGNER_PRIVATE_KEY=...                # intentionally-funded wallet only
POLICY_PRESET=starter                  # tighter caps
POLICY_DAILY_VOLUME_CAP_USD=1000       # smaller than starter's default
POLICY_ALLOWED_RECIPIENTS=0xKnownCounterparty1,0xKnownCounterparty2
POLICY_DRY_RUN=false
LOG_LEVEL=warn
SERA_HISTORY_DB=/var/lib/sera/history.db   # mode 0600
```

### Paper-trading / dry-run for evaluation

```bash
SERA_NETWORK=mainnet
SERA_SIGNER_MODE=local
SIGNER_PRIVATE_KEY=...
POLICY_DRY_RUN=true                    # all execute_swap refuses
LOG_LEVEL=debug
```

### Read-only public deployment (future)

When Streamable HTTP lands, the recommended posture will be:

```bash
SERA_SIGNER_MODE=readonly
# Stream tools = discovery + pricing + liquidity + history only
# Execution tools NOT registered
```

This is documented for completeness; the surface is not shipped yet.

## Audit findings status

Tracked publicly so deployers can see what's open. See `git log` for the latest closures.

| Finding | Status |
|---|---|
| Base URL allowlist (must hardcode by network) | Closed (v0.3.2) |
| Bearer-token concat at Sera REST | Documented Sera spec (`Authorization: Bearer {api_key}:{api_secret}`). Non-standard for Bearer (conventionally opaque), but intentional per docs.sera.cx — not a misuse, just unusual. |
| Quote uuid binding (refuse mismatched route_params) | Closed (v0.3.1) |
| Daily volume cap derivation (server-side) | Closed (v0.3.1) |
| Slippage clamp (defense-in-depth bound) | Open (hygiene) |
| SQLite history DB file mode 0600 | Open (hygiene) |
| Sera raw_response pass-through (defense-in-depth) | Open |
| Stack-trace logging on fatal | Partial |
| Prompt template injection | Closed (v0.3.1) |
| Recipient whitelist bypass when defaulting to owner | Open |
| External FX MITM via single-source mid trust | Mitigated by 3-source median |
| `limit_watcher` polling unrate-limited | Open (per-tool quota planned) |
