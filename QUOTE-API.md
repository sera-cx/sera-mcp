# Observed contract: `POST /swap/quote`

> **Status: community notes, not official.** [docs.sera.cx](https://docs.sera.cx) is
> authoritative. Everything below was observed against mainnet on **25–26 August 2026**
> with **no API key**, and cross-read against this repo's own `src/sera/types.ts` and
> `src/sera/client.ts`. Where the two disagreed, the source in this repo won.
> Sera moves quickly — treat dated observations as dated.

## Why this file exists

`src/sera/types.ts` already encodes the *shape* of the quote call. What a TypeScript
interface cannot carry is the part integrators actually get stuck on: which fields the
server insists on, what it does with each one, what the two different error envelopes
mean, and what an agent should do when it gets one. This file is that layer.

It is written for two readers: someone wiring a new host to this MCP who wants to see
the raw call underneath `sera.quote`, and an LLM agent author deciding how to handle a
failed quote without retrying uselessly.

## Request

Seven fields. All seven were required in every accepted request observed; omitting any
one produced a `4xx` rather than a defaulted value.

| Field | Type | Notes |
| --- | --- | --- |
| `from_token` | `string` | ERC-20 address of the token being sold. Addresses come from `GET /tokens`; this repo resolves symbols to addresses in `src/sera/tokens.ts`. |
| `to_token` | `string` | ERC-20 address of the token being bought. |
| `from_amount` | `string` | **Raw token units, not human decimals.** 10 USDC at 6 decimals is `"10000000"`. This is the single most common integration mistake — a human-decimal amount is a valid string, so it is accepted and quoted, just for a millionth of what you meant. |
| `owner_address` | `string` | The address whose balance funds the swap. Becomes `taker` in the returned intent. |
| `recipient` | `string` | Where the output goes. May differ from `owner_address`; that is how payouts to a third party are expressed. |
| `expiration` | `number` | Unix **seconds**, not milliseconds. A millisecond timestamp is far in the future and does not error at quote time. |
| `gas_mode` | `"receive_less" \| "pay_more"` | See below. |

```jsonc
{
  "from_token":    "0x…",   // token being sold
  "to_token":      "0x…",   // token being bought
  "from_amount":   "10000000",
  "owner_address": "0x…",
  "recipient":     "0x…",
  "expiration":    1756000000,
  "gas_mode":      "receive_less"
}
```

## `gas_mode`

`GasMode` decides **which side of the trade absorbs execution cost**, not how much it is.

- `receive_less` — the cost comes out of the output. The payer's input is exactly
  `from_amount`; the recipient receives less than the headline rate implies.
- `pay_more` — the output is held whole and the input grows to cover the cost. This is
  the mode a merchant flow wants: the invoice is the amount that must arrive, so the
  cost has to land on the payer.

Neither mode makes the cost smaller. Picking the wrong one silently moves who pays it,
which is the kind of bug that only shows up in reconciliation.

**Dated observation (25–26 Aug 2026):** across quotes at four sizes on the same pair,
the gas component came back as a roughly flat amount rather than a proportion of
notional. If that still holds, execution cost as a *percentage* is a function of trade
size, and small trades wear it hardest. Re-measure before relying on it.

## Response

```jsonc
{
  "uuid":         "…",   // bind this to the signature; see below
  "route_params": { /* SeraIntent — the EIP-712 struct you sign */ },
  "fee_breakdown": { "gas_cost_usd": "…", "gas_cost_from_token": "…" },  // optional
  "expires_at":   1756000000,
  "permit":       null   // or a PermitEnvelope
}
```

`route_params` is the EIP-712 `Intent` struct, signed under the domain
`{ name: "Sera", version: "1", chainId, verifyingContract: <sera_address> }`.
Its fields are `taker`, `inputToken`, `outputToken`, `maxInputAmount`,
`minOutputAmount`, `recipient`, `initialDepositAmount`, `uuid`, `deadline`.

Two things worth stating plainly, because both are load-bearing:

1. **The `uuid` binds the quote to the execution.** `POST /swap` takes `uuid` plus the
   signature over `route_params`. Signing one quote's params and submitting them under
   another quote's `uuid` is exactly the confusion this MCP's security model exists to
   prevent — see `SECURITY-MODEL.md`.
2. **`expires_at` is short.** A quote held across a slow human confirmation step is a
   quote that will be rejected. Re-quote rather than reuse.

### When `permit` is non-null

`permit` is a `PermitEnvelope` when the swap is **wallet-funded**
(`initialDepositAmount > 0`) and the input token supports EIP-2612. In that case
`POST /swap` **requires** `permit_signature` and `permit_deadline` alongside the intent
signature, and rejects the request without them.

`permit: null` means one of two quite different things:

- the token does not support permit — fall back to `POST /approve`; or
- the swap is vault-funded, so no permit is needed at all.

The envelope carries a ready-made `eip712` block (`domain`, `primaryType: "Permit"`,
`types`, `message`) — sign that as given rather than reconstructing it, and read
`current_allowance_raw` first: if allowance already covers `value_raw`, the permit is
redundant.

## Errors

`src/sera/client.ts` parses two distinct envelopes, and the difference matters to an
agent deciding what to do next:

```jsonc
// transport / validation — something about the request was wrong
{ "detail": { "detail": "…", "error_code": "…" } }

// business outcome — the request was well-formed, the trade cannot be made
{ "detail": { "success": false, "error": "no_liquidity" } }
```

`no_liquidity` is the second kind. It is **not** a malformed request and **not** a
transient failure, so the two obvious agent reflexes — re-validate the payload, or
retry the identical call — both waste a round trip. Note also that `client.ts` only
retries `503` on `GET`; a failed quote is a `POST` and is never retried for you.

Useful things to know about `no_liquidity` before surfacing it to a user:

- It is **per direction**. A pair quoting one way says nothing about the other way;
  the two legs must be tested independently.
- It is **per size**. The same direction can quote at one notional and not another, so
  a single failed amount does not establish that the pair is unavailable.

So the informative response to `no_liquidity` is to re-quote the *reverse* direction, or
a different size, and report which specific leg and size failed — not "the pair is
unsupported".

## Reproducing any of this

The endpoint answered without an API key, so every claim above is checkable directly:

```bash
# 1. Addresses and decimals for the pair you care about
curl -s https://api.sera.cx/api/v1/tokens

# 2. A quote. from_amount is RAW units — 10 USDC at 6 decimals is 10000000.
curl -s -X POST https://api.sera.cx/api/v1/swap/quote \
  -H 'content-type: application/json' \
  -d '{
    "from_token":    "<from address>",
    "to_token":      "<to address>",
    "from_amount":   "10000000",
    "owner_address": "<any address>",
    "recipient":     "<any address>",
    "expiration":    '"$(($(date +%s) + 600))"',
    "gas_mode":      "receive_less"
  }'
```

Quoting is read-only: it returns an unsigned intent and signs nothing. Executing is
`POST /swap` and needs a signature, which is a separate decision.

## Not covered here

Batch quoting (`BatchQuoteResponse`), order placement and cancellation, vault balances,
and anything about fee *levels*. On fees specifically: this repo's contracts express
`feeBps` as a per-order field rather than a fixed protocol percentage, so any single
percentage quoted as "the Sera fee" should be treated as unverified until it is read
back from an order.
