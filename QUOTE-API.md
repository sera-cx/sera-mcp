# `POST /swap/quote` — an integration reference

> **Community notes.** [docs.sera.cx](https://docs.sera.cx) is authoritative; this file is
> a companion for people wiring the raw call, cross-read against this repo's own
> `src/sera/types.ts` and `src/sera/client.ts` and checked against mainnet on
> **25–26 August 2026**. Where the two differed, the source in this repo won. Sera moves
> quickly, so anything dated here is worth re-checking rather than trusting.

## Why this file exists

`src/sera/types.ts` carries the *shape* of the quote call. This adds the layer around it:
what the server does with each field, what the response guarantees, and how an agent
author should reason about the result. It is written for two readers — someone wiring a
new host to this MCP who wants to see the raw call underneath `sera.quote`, and anyone
building a cost model on top of it.

Worth stating up front, because it is the unusual part: **quoting needs no API key, no
signature and no funded wallet.** One request prices a cross-currency swap. Most FX
venues will not show you a rate without a contract first.

## Request

Seven fields, all required. Fields the quote does not itself consume still need a valid
value — that is the interface contract, not an oversight.

| Field | Type | Notes |
| --- | --- | --- |
| `from_token` | `string` | ERC-20 address of the token being sold. Addresses come from `GET /tokens`; this repo resolves symbols to addresses in `src/sera/tokens.ts`. |
| `to_token` | `string` | ERC-20 address of the token being bought. |
| `from_amount` | `string` | **Raw token units, not human decimals.** 10 USDC at 6 decimals is `"10000000"`. Read `decimals` from `/tokens` and multiply. |
| `owner_address` | `string` | The address whose balance would fund the swap. Becomes `taker` in the returned intent. |
| `recipient` | `string` | Where the output goes. May differ from `owner_address` — that is how a payout to a third party is expressed. |
| `expiration` | `number` | Unix **seconds**. `GET /system/time` plus ten minutes is the safe way to set it. |
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
  `from_amount`; the recipient receives slightly less than the headline rate implies.
- `pay_more` — the output is held whole and the input grows to cover the cost. This is
  the mode a merchant or invoice flow wants: the amount that must arrive is fixed, so the
  cost belongs on the payer.

Both modes are valid and neither is a default to prefer — they express two different
commercial intents. Pick from the intent, since the choice moves who pays rather than
producing an error.

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

Three things worth stating plainly:

1. **`minOutputAmount` is a floor, not an estimate.** There is no "expected output"
   field, by design. Describe it to users as the guaranteed minimum, not as what they
   will receive — the two are different numbers and the difference matters to a maker.
2. **The `uuid` binds the quote to the execution.** `POST /swap` takes `uuid` plus the
   signature over `route_params`. Signing one quote's params and submitting them under
   another quote's `uuid` is exactly what this MCP's security model exists to prevent —
   see `SECURITY-MODEL.md`.
3. **`expires_at` is short.** A quote held across a slow human confirmation step will
   need re-quoting. Re-quote rather than reuse; quoting is cheap and unauthenticated.

### Cost is charged per transaction

`gas_cost_usd` came back as a flat amount across sizes rather than a proportion of
notional (measured 25–26 Aug 2026). That is a **per-transaction** cost structure, not a
percentage one — the larger the transfer, the thinner the fixed component spreads.

Model it as a fixed term rather than a rate, or the cost curve you derive will be the
wrong shape. Re-measure before relying on the figure itself.

### When `permit` is non-null

`permit` is a `PermitEnvelope` when the swap is **wallet-funded**
(`initialDepositAmount > 0`) and the input token supports EIP-2612. In that case
`POST /swap` **requires** `permit_signature` and `permit_deadline` alongside the intent
signature.

`permit: null` means one of two different things:

- the token does not implement permit — use `POST /approve`; or
- the swap is vault-funded, so no permit is needed at all.

The envelope carries a ready-made `eip712` block (`domain`, `primaryType: "Permit"`,
`types`, `message`) — sign that as given rather than reconstructing it, and read
`current_allowance_raw` first: if the allowance already covers `value_raw`, the permit is
redundant.

## Quoting per direction and per size

Each direction and each size is its own quote. To price a ladder or scan a set of
currencies, ask for each one rather than extrapolating from a single result — and use the
batch endpoint rather than looping:

```
POST /swap/quote/batch
```

with `{ "quotes": [ …the same object, repeated… ] }`.

## Reproducing any of this

Quoting is public, so every claim above is checkable directly:

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

Order placement and cancellation, vault balances, and fee *levels*. On fees specifically:
this repo's contracts express `feeBps` as a per-order field rather than a fixed protocol
percentage, so any single percentage quoted as "the Sera fee" should be treated as
unverified until it is read back from an order.
