import { z } from "zod";

// ─── Reusable validators ────────────────────────────────────────────────────
// Tighten the boundary so prompt-injection or malformed agent calls don't reach
// the handlers. Each validator has a hard upper length to bound logging cost.

const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x-prefixed 40-hex EVM address");
const FiatCode = z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter fiat code").transform((s) => s.toUpperCase());
const TokenSymbol = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,11}$/, "must be a 2-12 char token symbol");
const Uuid = z.string().regex(/^[0-9a-fA-F-]{8,80}$/, "must be a uuid");
const HexSignature = z.string().regex(/^0x[0-9a-fA-F]{8,520}$/, "must be 0x-prefixed hex (signature)").max(520);
const DecimalAmount = z.union([
  z.number().positive().finite(),
  z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal").max(40),
]);

// CurrencyRef accepts symbol, address, or fiat — bounded length, no exotic chars.
const CurrencyRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]{2,12}$|^0x[0-9a-fA-F]{40}$/, "must be a token symbol, fiat code, or 0x address")
  .describe("Symbol (USDC), ERC-20 address, or fiat code (e.g. SGD).");

export const ListCurrenciesInput = z.object({
  fiat: z
    .string()
    .optional()
    .describe("Optional 3-letter fiat code filter (e.g. 'USD'). Returns only stablecoins of that fiat."),
});

export const GetMarketsInput = z.object({});

export const GetFxRateInput = z.object({
  base: FiatCode.describe("Base ISO currency code (e.g. 'GBP')."),
  quote: FiatCode.describe("Quote ISO currency code (e.g. 'USD')."),
});

export const GetBalancesInput = z.object({
  owner_address: EvmAddress.describe("0x… wallet address to query. Requires API key auth."),
});

export const GetQuoteInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: DecimalAmount.describe("Human amount in `from` units (e.g. '100' = 100 USDC)."),
  owner_address: EvmAddress
    .optional()
    .describe("Wallet that will fund the swap (becomes Intent.taker). Required unless simulate=true."),
  recipient: EvmAddress.optional().describe("Where output tokens should land. Defaults to owner_address."),
  gas_mode: z.enum(["receive_less", "pay_more"]).default("receive_less"),
  expiration_seconds: z
    .number()
    .int()
    .positive()
    .max(3600)
    .optional()
    .describe("Quote validity window. Bounded by POLICY_MAX_EXPIRATION_SECONDS at handler time."),
  simulate: z
    .boolean()
    .optional()
    .describe(
      "If true, use the burn address as owner — for read-only price/depth probing. The returned route_params can NOT be executed.",
    ),
});

export const PrepareSwapInput = GetQuoteInput.extend({});

export const ExecuteSwapInput = z.object({
  uuid: Uuid.describe("Quote UUID returned by get_quote / prepare_swap."),
  signature: HexSignature
    .optional()
    .describe(
      "Hex EIP-712 signature over `route_params`. Required when signer mode is 'external'. " +
        "In 'local' mode the server signs and this can be omitted.",
    ),
  route_params: z
    .record(z.any())
    .optional()
    .describe(
      "Optional. If provided, must EXACTLY match what this MCP returned for the uuid (refused on mismatch). " +
        "In external mode the upstream signature is the security boundary; in local mode the server-side registry binding is enforced.",
    ),
  permit_signature: HexSignature
    .optional()
    .describe(
      "EIP-2612 permit signature. REQUIRED when the originating get_quote response carried a non-null `permit` envelope (wallet-funded swap on EIP-2612-supported token). Sign `quote.permit.eip712` under that token's domain. Sera POST /swap rejects without this when the quote was issued with permit.",
    ),
  permit_deadline: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "EIP-2612 permit deadline (unix seconds). Must equal `quote.permit.eip712.message.deadline`. Required iff permit_signature is provided.",
    ),
});

export const ConvertAndSendInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: DecimalAmount,
  owner_address: EvmAddress,
  recipient: EvmAddress.describe("Final destination address for the output token."),
  gas_mode: z.enum(["receive_less", "pay_more"]).default("receive_less"),
});

export const QuoteRecipientAmountInput = z.object({
  from: CurrencyRef.describe("Token you're paying with."),
  to: CurrencyRef.describe("Currency the recipient should receive."),
  recipient_amount: z
    .union([z.string(), z.number()])
    .describe("How much the recipient should end up with, in `to` human units."),
  owner_address: z.string(),
  recipient: z.string().optional(),
});

export const FindCheapestPathInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: z.union([z.string(), z.number()]),
  owner_address: z.string(),
});

export const ScanMarketsInput = z.object({
  pairs: z
    .array(z.object({ base: z.string(), quote: z.string() }))
    .optional()
    .describe("Explicit list of pairs. If omitted, enumerates from /markets and applies max_pairs."),
  notional_per_quote: z
    .number()
    .positive()
    .optional()
    .describe("Human amount in `from` units used for each probe. Default 100."),
  max_pairs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on pairs scanned when no explicit list is given. Default 50."),
  max_concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Bounded parallelism. Default 8 — keep below 25 to be polite."),
  only_policy_allowed: z
    .boolean()
    .optional()
    .describe("If true (default), restrict enumeration to symbols in POLICY_ALLOWED_SYMBOLS."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const CompareToExternalFxInput = z.object({
  base: z.string().describe("ISO fiat (e.g. 'USD') OR a Sera token symbol (e.g. 'USDC')."),
  quote: z.string().describe("ISO fiat (e.g. 'SGD') OR a Sera token symbol (e.g. 'XSGD')."),
});

export const ProbeDepthInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  sizes: z
    .array(z.number().positive())
    .optional()
    .describe("Human input sizes to probe. Default [100, 1000, 10000, 100000]."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
  max_concurrency: z.number().int().positive().optional(),
});

export const RoundTripCostInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: z.number().positive().describe("Human amount in `from` units."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const InferBookInput = z.object({
  base: CurrencyRef,
  quote: CurrencyRef,
  sizes: z
    .array(z.number().positive())
    .optional()
    .describe("Probe sizes (in respective input currency). Default log-spaced 100→1M."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const FxHistoryInput = z.object({
  base: z.string(),
  quote: z.string(),
  since_hours_ago: z.number().positive().optional().describe("Default 24."),
});

export const TreasuryValueInput = z.object({
  owner_addresses: z.array(z.string()).min(1).describe("One or more 0x... wallets to aggregate."),
  target_currency: z.string().optional().describe("ISO fiat to value in. Default 'USD'."),
  include_zero: z.boolean().optional().describe("Include zero-balance lines. Default false."),
});

export const ExposureReportInput = TreasuryValueInput.pick({ owner_addresses: true, target_currency: true });

export const RebalancePlanInput = z.object({
  owner_addresses: z.array(z.string()).min(1),
  target_weights: z
    .record(z.number().nonnegative())
    .describe("Map of fiat code → weight, e.g. { USD: 50, SGD: 30, MYR: 20 }. Normalized internally."),
  target_currency: z.string().optional(),
  min_trade_value: z
    .number()
    .nonnegative()
    .optional()
    .describe("Skip suggested trades below this value (in target_currency). Default 10."),
});

export const PayInvoiceInput = z.object({
  owner_address: z.string(),
  recipient: z.string(),
  amount: z.number().positive().describe("Recipient should receive exactly this in `target_currency` units."),
  target_currency: z.string().describe("ISO fiat the recipient wants (e.g. 'SGD')."),
  source_symbols: z.array(z.string()).min(1).describe("Stablecoins available to spend (e.g. ['USDC','USDT','EURC'])."),
  target_symbol: z.string().optional().describe("Specific output token; defaults to a stablecoin matching target_currency."),
});

export const DoctorInput = z.object({});

export const FindDealsInput = z.object({
  pairs: z
    .array(z.object({ base: z.string(), quote: z.string() }))
    .optional()
    .describe("Explicit pair list. If omitted, enumerates from /markets and applies max_pairs."),
  notional_per_quote: z.number().positive().optional(),
  max_pairs: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().optional(),
  only_policy_allowed: z.boolean().optional(),
  min_deviation_bps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum |deviation| from benchmark to count as a deal. Default 25."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
  use_multi_source: z
    .boolean()
    .optional()
    .describe(
      "True (default): benchmark = median of 3 external FX sources. False: benchmark = sera.get_fx_rate.",
    ),
});

export const MakerQuoteLadderInput = z.object({
  base: CurrencyRef,
  quote: CurrencyRef,
  notional: z.number().positive().describe("Amount in the SELL leg."),
  role: z
    .enum(["maker_sell_base", "maker_buy_base"])
    .optional()
    .describe("Are you selling base for quote, or buying base with quote? Default sell."),
  mid: z.number().positive().optional().describe("Override the mid. If omitted, fetched per mid_source."),
  mid_source: z
    .enum(["multi_source", "sera"])
    .optional()
    .describe("multi_source = median of external sources (default). sera = sera.get_fx_rate."),
  spreads_bps: z
    .array(z.number().positive())
    .optional()
    .describe("Spreads to ladder. Default [5, 10, 15, 25, 50, 100, 200]."),
});

export const MultiSourceMidInput = z.object({
  base: z.string().describe("ISO fiat or Sera token symbol."),
  quote: z.string().describe("ISO fiat or Sera token symbol."),
});

export const LimitWatcherInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: z.number().positive(),
  target_rate: z
    .number()
    .positive()
    .describe("Threshold (output_per_input) at which the watcher should fire."),
  side: z
    .enum(["sell_from", "buy_from"])
    .describe(
      "sell_from = wait until rate >= target (best when selling 'from'). buy_from = wait until rate <= target.",
    ),
  max_attempts: z.number().int().positive().max(30).optional().describe("Default 5; capped at 30."),
  interval_seconds: z
    .number()
    .int()
    .positive()
    .max(60)
    .optional()
    .describe("Sleep between attempts. Default 6, capped at 60."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const SettlementStatusInput = z.object({
  trade_id: z.string().optional(),
  uuid: z.string().optional(),
  owner_address: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const MarketHealthInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const FxQuoteDiffInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  notional: z
    .number()
    .positive()
    .optional()
    .describe("Amount used for the executable probe. Default 100."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const CompareCorridorsInput = z.object({
  target: CurrencyRef.describe("Output currency or token to deliver."),
  target_amount: z.number().positive().describe("Exact amount of `target` to deliver."),
  sources: z.array(z.string()).min(1).describe("Candidate source token symbols to compare."),
  max_concurrency: z.number().int().positive().max(10).optional(),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const SpreadRadarInput = z.object({
  currencies: z
    .array(z.string())
    .optional()
    .describe(
      "List of ISO fiat codes to scan (e.g. ['USD','SGD','MYR']). Defaults to USD/SGD/MYR/EUR/GBP/JPY.",
    ),
  spread_alert_bps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Flag pairs whose forward*reverse rate deviates from 1.0 by ≥ this many bps. Default 50."),
  triangular_alert_bps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Flag triangles whose round-trip product deviates from 1.0 by ≥ this many bps. Default 50."),
  include_triangles: z
    .boolean()
    .optional()
    .describe("Set false to skip triangular checks (cheaper, only n*(n-1) calls). Default true."),
});

// ──────────────────────────────────────────────────────── account / funds flow
// All `build*` tools return an unsigned EIP-1559 transaction object the caller
// must sign locally and broadcast via the paired `send_*` tool (or any other
// RPC). Tx-building helpers all require API Key auth.

const RawTxHex = z.string().regex(/^0x[0-9a-fA-F]+$/, "must be 0x-prefixed hex raw tx").min(4).max(20_000);
const Uint256Decimal = z.string().regex(/^\d+$/, "must be a uint256 decimal string");

export const BuildApproveInput = z.object({
  token: EvmAddress.describe("ERC-20 token address."),
  owner: EvmAddress.describe("Owner wallet (must match the authenticated API-key owner)."),
  spender: EvmAddress.describe("Allowance target. Must be the live Vault or SOR address from sera://config / GET /config."),
  amount: Uint256Decimal.describe("Raw uint256 allowance amount (token base units)."),
});

export const BuildDepositInput = z.object({
  token: EvmAddress,
  owner: EvmAddress,
  amount: Uint256Decimal.describe("Raw uint256 deposit amount."),
  permit_signature: HexSignature.optional().describe("Optional EIP-2612 permit signature — if present, deposit + permit combined in one tx (depositFundWithPermit)."),
  permit_deadline: z.number().int().positive().optional(),
  permit_amount: Uint256Decimal.optional().describe("Permit allowance amount (defaults to `amount` when omitted)."),
});

export const BuildTransferInput = z.object({
  token: EvmAddress,
  to: EvmAddress.describe("Recipient address."),
  amount: Uint256Decimal,
  from_address: EvmAddress.describe("Sender wallet."),
});

export const SendTxInput = z.object({
  raw_tx: RawTxHex.describe("Locally-signed raw transaction hex. Returned from approve/deposit/transfer build calls."),
});

export const SendTransferInput = z.object({
  raw_tx: RawTxHex,
});

// ──────────────────────────────────────────────────────── withdraw (dual-sig)
// Withdraw is a 4-step flow:
//   1. withdraw_request — user signs WithdrawIntent; executor co-signs.
//   2. withdraw_build   — server builds unsigned tx given both signatures.
//   3. (off-server) user signs the unsigned tx locally.
//   4. withdraw_send    — broadcast.

const WithdrawIntentSchema = z.object({
  user: EvmAddress,
  tokens: z.array(EvmAddress).min(1).max(20).describe("1–20 token addresses to withdraw."),
  amounts: z.array(Uint256Decimal).min(1).max(20).describe("Per-token raw uint256 amounts. Length must match tokens[]."),
  recipient: EvmAddress.describe("Destination wallet."),
  deadline: z.string().regex(/^\d+$/, "uint256 unix seconds").describe("Unix timestamp deadline. Must be future and ≤365d − 300s out."),
  uuid: z.string().regex(/^\d+$/, "uint256 decimal").describe("Replay-protection identifier."),
});

export const WithdrawRequestInput = z.object({
  intent: WithdrawIntentSchema,
  user_signature: HexSignature.describe("EIP-712 signature over the WithdrawIntent struct under the Sera domain."),
});

export const WithdrawBuildInput = z.object({
  intent: WithdrawIntentSchema,
  user_signature: HexSignature,
  executor: EvmAddress.describe("Co-signing executor address from withdraw_request response."),
  executor_signature: HexSignature,
});

export const WithdrawSendInput = z.object({
  raw_tx: RawTxHex,
});

// ──────────────────────────────────────────────────────── batch quote
export const BatchQuoteInput = z.object({
  quotes: z
    .array(
      z.object({
        from: CurrencyRef,
        to: CurrencyRef,
        amount: DecimalAmount,
        owner_address: EvmAddress.optional(),
        recipient: EvmAddress.optional(),
        gas_mode: z.enum(["receive_less", "pay_more"]).default("receive_less"),
        expiration_seconds: z.number().int().positive().optional(),
        simulate: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(50)
    .describe("1–50 quote requests in a single round-trip. Mirrors POST /swap/quote/batch."),
});

// ──────────────────────────────────────────────────────── verify signature
export const VerifySignatureInput = z.object({
  owner_address: EvmAddress,
  side: z.enum(["bid", "ask"]),
  amount: DecimalAmount,
  price: DecimalAmount,
  from_address: EvmAddress.describe("Market base token address."),
  to_address: EvmAddress.describe("Market quote token address."),
  order_id: Uuid,
  uuid_int: z.string().regex(/^\d+$/, "uint256 decimal"),
  signature: HexSignature,
  expiration: z.number().int().positive(),
});

// ─────────────────────────────────────────────────────────── output schemas
// Output schemas drive MCP's `structuredContent` field. Hosts that validate
// or render tool output use these. Migration is incremental — start with
// tools whose return shape is fully controlled in this codebase.

export const DoctorOutput = z.object({
  network_label: z.enum(["mainnet", "sepolia"]),
  base_url: z.string(),
  overall_ok: z.boolean(),
  checks: z.array(
    z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }),
  ),
});

export const MarketHealthOutput = z.object({
  pair: z.string(),
  status: z.enum(["quotable", "no_liquidity", "unknown_pair", "error"]),
  detail: z.string().optional(),
});

export const FxRateOutput = z.object({
  pair: z.string(),
  rate: z.string(),
  as_of: z.number().optional(),
  rate_24h_ago: z.union([z.string(), z.null()]).optional(),
  as_of_24h_ago: z.union([z.number(), z.null()]).optional(),
  change_pct: z.union([z.string(), z.null()]).optional(),
}).passthrough();

export const ListCurrenciesOutput = z.object({
  count: z.number(),
  policy_allowed_symbols: z.union([z.array(z.string()), z.literal("all")]),
  tokens: z.array(
    z.object({
      symbol: z.string(),
      fiat_currency: z.string().optional(),
      address: z.string(),
      decimals: z.number(),
      policy_allowed: z.boolean(),
    }),
  ),
});

// ──────────────────────────────────────────────────────── permit metadata
export const PermitMetadataInput = z.object({
  token: EvmAddress.describe("ERC-20 token to check for EIP-2612 support."),
  owner: EvmAddress.describe("Wallet that may sign permit."),
  spender: EvmAddress.describe("Allowance target — typically vault_address or sor_address (from sera://config)."),
  amount: Uint256Decimal.optional().describe("Raw amount to compare against current allowance. When set, response includes `required: bool`."),
});

// ──────────────────────────────────────────────────────── maker / orders
// All order placements take a wire-payload (pair-natural fields) AND a signed
// EIP-712 Order struct. The MCP forwards as-is to Sera — the agent signs.

const OrderSide = z.enum(["bid", "ask"]);

const SignedOrderBody = z.object({
  owner_address: EvmAddress,
  side: OrderSide,
  amount: DecimalAmount.describe("Quantity in base-token natural units."),
  price: DecimalAmount.describe("Quote per base, natural units."),
  order_type: z.literal("limit"),
  from_address: EvmAddress.describe("Market BASE token address (not spend direction)."),
  to_address: EvmAddress.describe("Market QUOTE token address."),
  order_id: Uuid.describe("Client-picked UUID4 (server dedupes — safe to retry)."),
  uuid_int: z.string().regex(/^\d+$/, "uint256 decimal"),
  signature: HexSignature.describe("EIP-712 signature over the Order struct under the Sera domain."),
  expiration: z.number().int().positive(),
});

export const PlaceOrderInput = SignedOrderBody;

export const CancelOrderInput = z.object({
  owner_address: EvmAddress,
  order_id: Uuid,
  uuid_int: z.string().regex(/^\d+$/, "uint256 decimal"),
  signature: HexSignature,
});

export const CancelAllOrdersInput = z.object({
  owner_address: EvmAddress.describe("Must match the authenticated API-key owner."),
});

export const PlaceVlBatchInput = z.object({
  orders: z.array(SignedOrderBody).min(2).max(50).describe("2–50 signed orders. All must share the same owner_address and same fromToken; uuid_int's must share a single VL group_id; leg_id's must be 0,1,2,… in array order."),
});

export const CancelVlBatchInput = z.object({
  owner_address: EvmAddress,
  vl_batch_id: Uuid,
  signature: HexSignature,
});

export const GetOrderInput = z.object({
  order_id: Uuid,
});

export const ListOrdersInput = z.object({
  owner_address: EvmAddress,
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
  status: z.enum(["pending", "matched", "settled", "cancelled", "failed"]).optional(),
  type: z.enum(["swap", "limit"]).optional(),
  symbol: z.string().optional().describe("e.g. 'EURC/USDC'."),
  side: OrderSide.optional(),
  from_token: EvmAddress.optional(),
  to_token: EvmAddress.optional(),
  base_token: EvmAddress.optional(),
  quote_token: EvmAddress.optional(),
  has_error: z.boolean().optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  sort_by: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export const GetFillsInput = z.object({
  owner_address: EvmAddress,
  order_status: z.enum(["pending", "matched", "settled", "cancelled", "failed"]).optional(),
  settlement_status: z.enum(["pending", "confirming", "settled", "failed", "reverted"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const GetFillsForOrderInput = z.object({
  order_id: Uuid,
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
});
