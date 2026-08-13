/**
 * Tool registry — single source of truth for every MCP tool the server exposes.
 *
 * Each entry carries: name, human title, description, input schema, annotations,
 * capability group (for Phase 2 tool-group filtering), and the handler.
 *
 * The category field drives the future read/exec split. Annotations are advisory
 * signals to the host runtime (LLM and confirmation UX) — see MCP spec for
 * exact semantics.
 *
 * Adding a tool: append a record, set the correct category + annotations,
 * import the handler. No further wiring needed.
 */

import type { ZodTypeAny } from "zod";

import type { AppContext } from "../config.js";

import {
  BatchQuoteInput,
  BuildApproveInput,
  BuildDepositInput,
  BuildTransferInput,
  CancelAllOrdersInput,
  CancelOrderInput,
  CancelVlBatchInput,
  CompareCorridorsInput,
  CompareToExternalFxInput,
  ConvertAndSendInput,
  DoctorInput,
  DoctorOutput,
  FxRateOutput,
  ListCurrenciesOutput,
  MarketHealthOutput,
  ExecuteSwapInput,
  ExposureReportInput,
  FindCheapestPathInput,
  FindDealsInput,
  FxHistoryInput,
  GetCoinHistoryInput,
  GetTradingPairsInput,
  GetWalletInfoInput,
  GetCoinMetadataInput,
  SearchCoinsInput,
  FxQuoteDiffInput,
  GetBalancesInput,
  GetFillsForOrderInput,
  GetFillsInput,
  GetFxRateInput,
  GetMarketsInput,
  GetOrderInput,
  GetQuoteInput,
  InferBookInput,
  LimitWatcherInput,
  ListCurrenciesInput,
  ListOrdersInput,
  MakerQuoteLadderInput,
  MarketHealthInput,
  MultiSourceMidInput,
  PayInvoiceInput,
  PermitMetadataInput,
  PlaceOrderInput,
  PlaceVlBatchInput,
  PrepareSwapInput,
  ProbeDepthInput,
  QuoteRecipientAmountInput,
  RebalancePlanInput,
  RoundTripCostInput,
  ScanMarketsInput,
  SendTransferInput,
  SendTxInput,
  SettlementStatusInput,
  SpreadRadarInput,
  TreasuryValueInput,
  VerifySignatureInput,
  WithdrawBuildInput,
  WithdrawRequestInput,
  WithdrawSendInput,
} from "./schemas.js";

import {
  executeSwap,
  getBalances,
  getCoinHistory,
  getCoinMetadata,
  getFxRate,
  getMarkets,
  getQuote,
  getTradingPairs,
  listCurrencies,
  prepareSwap,
  searchCoins,
} from "./core.js";
import {
  convertAndSend,
  findCheapestPath,
  quoteRecipientAmount,
} from "./semantic.js";
import { spreadRadar } from "./insights.js";
import { scanMarkets } from "./scan.js";
import { compareToExternalFx } from "./external.js";
import { probeDepth, roundTripCost, inferBook } from "./depth.js";
import { fxHistory, fxVolatility, corridorPnl } from "./history.js";
import {
  treasuryValue,
  exposureReport,
  rebalancePlan,
  payInvoice,
} from "./treasury.js";
import { doctor, getWalletInfo } from "./admin.js";
import { findDeals } from "./deals.js";
import { makerQuoteLadder, multiSourceMid } from "./maker.js";
import { limitWatcher } from "./watcher.js";
import { settlementStatus } from "./settlement.js";
import {
  marketHealth,
  fxQuoteDiff,
  compareCorridors,
} from "./health_corridors.js";
import {
  buildApprove,
  buildDeposit,
  buildTransfer,
  sendTx,
  sendTransfer,
  withdrawRequest,
  withdrawBuild,
  withdrawSend,
} from "./account.js";
import { batchQuote, verifySignature, permitMetadata } from "./helpers.js";
import {
  placeOrder,
  cancelOrder,
  cancelAllOrders,
  placeVlBatch,
  cancelVlBatch,
  getOrder,
  listOrders,
  getFillsForOrder,
  listFills,
} from "./maker_orders.js";

/**
 * Tool capability group. Drives future read/exec server split and the
 * SERA_ENABLE_EXECUTION_TOOLS opt-in gate.
 *
 * Categories:
 *   discovery       — list available currencies, markets, server self-check
 *   pricing         — Sera + external FX reference rates, mid analytics
 *   liquidity       — probe quotability, depth, deal-scan, market health
 *   quote_planning  — quote, prepare, route, plan, patient/limit watcher
 *   treasury        — wallet balances, exposure, rebalance plan, invoice pay,
 *                     settlement-history queries (require API key)
 *   history         — local SQLite price-history queries
 *   execution       — sign + submit swaps (destructive, signer-mode gated)
 */
export type ToolCategory =
  | "discovery"
  | "pricing"
  | "liquidity"
  | "quote_planning"
  | "treasury"
  | "history"
  | "execution"
  | "account"        // tx builders + broadcast helpers
  | "withdraw"       // dual-sig 4-step withdraw
  | "debugging"      // verify_signature, permit_metadata
  | "maker";         // limit orders, cancels, VL batches

/**
 * MCP tool annotations carried into registerTool().
 * Pulled inline so we don't depend on a specific SDK-internal type path.
 */
export interface ToolAnnotations {
  /** Human-readable title shown by hosts that want a friendly label. */
  title?: string;
  /** No side effects. Same input → same output (modulo upstream FX moves). */
  readOnly?: boolean;
  /** Side effects exist and may be impossible to reverse (money moves). */
  destructive?: boolean;
  /** Repeated calls with identical args are safe (cache-able). */
  idempotent?: boolean;
  /** Tool interacts with external systems (Sera API, external FX sources). */
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodTypeAny;
  /** Optional output schema. Drives structuredContent on tool responses for hosts that validate/render output. */
  outputSchema?: ZodTypeAny;
  annotations: ToolAnnotations;
  category: ToolCategory;
  handler: (ctx: AppContext, args: any) => Promise<unknown>;
}

/**
 * Common annotation patterns. Use these helpers when adding tools so the
 * read/exec boundary stays clear.
 */
const ANN = {
  /** Read-only tool: idempotent, no side effects, hits Sera or external API. */
  read: (title: string): ToolAnnotations => ({
    title,
    readOnly: true,
    idempotent: true,
    openWorldHint: true,
  }),
  /** Pure planning: takes data, returns suggestions. No external call. */
  pureRead: (title: string): ToolAnnotations => ({
    title,
    readOnly: true,
    idempotent: true,
    openWorldHint: false,
  }),
  /** Local-only read (e.g. SQLite history). */
  localRead: (title: string): ToolAnnotations => ({
    title,
    readOnly: true,
    idempotent: true,
    openWorldHint: false,
  }),
  /** Quote: read-only but not idempotent (uuids burn on issue). */
  quote: (title: string): ToolAnnotations => ({
    title,
    readOnly: true,
    idempotent: false,
    openWorldHint: true,
  }),
  /** Destructive: money moves; never idempotent; not safe to retry blindly. */
  destructive: (title: string): ToolAnnotations => ({
    title,
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorldHint: true,
  }),
};

export const TOOLS: ToolDef[] = [
  // ────────────────────────────────────────────────────────────── discovery
  {
    name: "sera.list_currencies",
    title: "List supported currencies",
    description:
      "List supported stablecoins from Sera's live token registry. Use this before any swap to discover symbols, fiat tags, addresses, and decimals. Optionally filter by fiat (e.g. fiat='SGD'). Cached 5min server-side.",
    inputSchema: ListCurrenciesInput,
    outputSchema: ListCurrenciesOutput,
    annotations: ANN.read("List currencies"),
    category: "discovery",
    handler: (ctx, args) => listCurrencies(ctx, args ?? {}),
  },
  {
    name: "sera.get_markets",
    title: "List active markets",
    description:
      "List the active trading-pair catalog from /markets. NOTE: pair existence ≠ tradeable now — use sera.scan_markets to find what's actually quotable. Cached 10min server-side.",
    inputSchema: GetMarketsInput,
    annotations: ANN.read("Markets"),
    category: "discovery",
    handler: (ctx) => getMarkets(ctx),
  },
  {
    name: "sera.get_trading_pairs",
    title: "Trading pairs for a token",
    description:
      "List every market a single token can be swapped through, with the side (ASK/BID) you'd trade to leave that token. Token-centric view of /markets — use this instead of sera.get_markets when you already know the token and want its routes. Accepts symbol, 0x address, or fiat tag. Same caveat as get_markets: pair existence ≠ tradeable now.",
    inputSchema: GetTradingPairsInput,
    annotations: ANN.read("Trading pairs"),
    category: "discovery",
    handler: (ctx, args) => getTradingPairs(ctx, args),
  },
  {
    name: "sera.get_wallet_info",
    title: "Signer identity",
    description:
      "Who is this server signing as? Returns signer mode, resolved taker address (null in external/readonly mode — that is normal, not an error), whether execution tools are exposed, and the active network. Cheap local-only answer to 'whose address will my swap use' — sera.doctor covers the same ground plus API health at the cost of several round-trips. Does not report gas balance: this server holds no RPC.",
    inputSchema: GetWalletInfoInput,
    annotations: ANN.pureRead("Signer identity"),
    category: "discovery",
    handler: (ctx) => getWalletInfo(ctx),
  },
  {
    name: "sera.doctor",
    title: "Server self-check",
    description:
      "One-call self-check: API health, executor_id, network sanity, contract addresses, VL batch limits, signer mode, policy summary, persistence state. Use for 'is everything wired right' debugging.",
    inputSchema: DoctorInput,
    outputSchema: DoctorOutput,
    annotations: ANN.read("Doctor"),
    category: "discovery",
    handler: (ctx) => doctor(ctx),
  },
  {
    name: "sera.search_coins",
    title: "Search coins",
    description:
      "Fuzzy-find stablecoins in Sera's live /tokens registry by case-insensitive substring match on symbol, name, or fiat tag (e.g. query='sgd'). Convenience wrapper over the same registry as sera.list_currencies. Cached ~1min server-side.",
    inputSchema: SearchCoinsInput,
    annotations: ANN.read("Search coins"),
    category: "discovery",
    handler: (ctx, args) => searchCoins(ctx, args),
  },
  {
    name: "sera.get_coin_metadata",
    title: "Coin metadata",
    description:
      "Full registry metadata (symbol, name, fiat, address, decimals) for a single stablecoin by symbol from Sera's /tokens registry. Case-insensitive; returns an honest not-found object if the symbol is unknown.",
    inputSchema: GetCoinMetadataInput,
    annotations: ANN.read("Coin metadata"),
    category: "discovery",
    handler: (ctx, args) => getCoinMetadata(ctx, args),
  },
  {
    name: "sera.get_coin_history",
    title: "Coin price history",
    description:
      "Historical FX observations for a coin's implied fiat pair (e.g. XSGD -> SGD/USD). Sera publishes no OHLC, so this replays this MCP's own logged /fx/rate points and REQUIRES SERA_HISTORY_DB — returns an honest disabled/empty response otherwise. Never fabricates prices.",
    inputSchema: GetCoinHistoryInput,
    annotations: ANN.read("Coin history"),
    category: "discovery",
    handler: (ctx, args) => getCoinHistory(ctx, args),
  },

  // ──────────────────────────────────────────────────────────────── pricing
  {
    name: "sera.get_fx_rate",
    title: "Sera FX rate",
    description:
      "Sera's reference FX rate between two ISO currency codes (e.g. base='SGD', quote='USD'). Has measurable bid/ask asymmetry — for execution price, always use sera.get_quote. To detect Sera vs market bias, pair with sera.compare_to_external_fx. Cached 60s server-side.",
    inputSchema: GetFxRateInput,
    outputSchema: FxRateOutput,
    annotations: ANN.read("FX rate"),
    category: "pricing",
    handler: (ctx, args) => getFxRate(ctx, args),
  },
  {
    name: "sera.compare_to_external_fx",
    title: "Compare Sera FX vs external mid",
    description:
      "Diff Sera's /fx/rate against Frankfurter (ECB published mid). Surfaces systematic pricing bias. Inputs accept ISO fiat codes ('USD','SGD') OR Sera token symbols ('USDC','XSGD'). Note: Frankfurter updates daily, not real-time.",
    inputSchema: CompareToExternalFxInput,
    annotations: ANN.read("FX bias"),
    category: "pricing",
    handler: (ctx, args) => compareToExternalFx(ctx, args),
  },
  {
    name: "sera.multi_source_mid",
    title: "Multi-source FX mid",
    description:
      "Median FX mid across 3 free external sources (Frankfurter / open.er-api / exchangerate.host). Per-source rate, median, range_bps. Inputs accept ISO fiat ('USD') or Sera token symbol ('USDC'). Resilient to a single source being down.",
    inputSchema: MultiSourceMidInput,
    annotations: ANN.read("Multi-source mid"),
    category: "pricing",
    handler: (ctx, args) => multiSourceMid(ctx, args),
  },
  {
    name: "sera.spread_radar",
    title: "FX spread radar",
    description:
      "Liquidity-free FX consistency monitor across a currency basket. Flags forward/reverse pair asymmetry and triangular drift. Useful as a pre-trade integrity check or to detect upstream pricing-source drift. Defaults: 150bps thresholds, USD/SGD/MYR/EUR/GBP/JPY basket.",
    inputSchema: SpreadRadarInput,
    annotations: ANN.read("Spread radar"),
    category: "pricing",
    handler: (ctx, args) => spreadRadar(ctx, args ?? {}),
  },

  // ────────────────────────────────────────────────────────────── liquidity
  {
    name: "sera.scan_markets",
    title: "Scan markets for quotable pairs",
    description:
      "Fan out parallel /swap/quote probes across many pairs. Built for the deal-scanner pattern: one tool call instead of N round-trips. Default: 50 pairs, 8 concurrent, $100 notional, restricted to POLICY_ALLOWED_SYMBOLS. Reports quotable rate per pair and skip reasons (no_liquidity etc.).",
    inputSchema: ScanMarketsInput,
    annotations: ANN.read("Scan markets"),
    category: "liquidity",
    handler: (ctx, args) => scanMarkets(ctx, args ?? {}),
  },
  {
    name: "sera.find_deals",
    title: "Find deals vs external mid",
    description:
      "End-to-end deal scanner: scan_markets + per-pair external mid comparison + filter ≥ min_deviation_bps. Returns ranked good_sell / good_buy / fair lists. Default benchmark = median of 3 free external FX sources (Frankfurter / open.er-api / exchangerate.host). Use_multi_source:false to compare against Sera's own /fx/rate instead.",
    inputSchema: FindDealsInput,
    annotations: ANN.read("Find deals"),
    category: "liquidity",
    handler: (ctx, args) => findDeals(ctx, args ?? {}),
  },
  {
    name: "sera.maker_quote_ladder",
    title: "Maker spread ladder",
    description:
      "Spread-ladder calculator for makers. Given a pair, notional, and (optional) mid, returns earnings at 5/10/15/25/50/100/200 bps. Mid auto-fetched from multi-source median by default. Mirrors the Sera Spread Calculator UX as a single tool call.",
    inputSchema: MakerQuoteLadderInput,
    annotations: ANN.read("Maker ladder"),
    category: "liquidity",
    handler: (ctx, args) => makerQuoteLadder(ctx, args),
  },
  {
    name: "sera.probe_depth",
    title: "Probe price impact at sizes",
    description:
      "Quote one corridor at a ladder of sizes to characterize price impact. Returns price-impact bps relative to the smallest probe. Use before sizing a real trade. Default sizes: [100, 1000, 10000, 100000].",
    inputSchema: ProbeDepthInput,
    annotations: ANN.quote("Probe depth"),
    category: "liquidity",
    handler: (ctx, args) => probeDepth(ctx, args),
  },
  {
    name: "sera.round_trip_cost",
    title: "Round-trip cost (A→B→A)",
    description:
      "Cost of A→B→A in bps. The spread floor a maker on this pair needs to cover their hedge. Returns absolute loss + bps interpretation.",
    inputSchema: RoundTripCostInput,
    annotations: ANN.quote("Round-trip"),
    category: "liquidity",
    handler: (ctx, args) => roundTripCost(ctx, args),
  },
  {
    name: "sera.infer_book",
    title: "Inferred order book",
    description:
      "Synthetic order book for a pair Sera doesn't publish a book for. Probes both directions at log-spaced sizes and constructs bid/ask ladders + a synthetic spread. Use for visualizing depth, not for execution.",
    inputSchema: InferBookInput,
    annotations: ANN.quote("Inferred book"),
    category: "liquidity",
    handler: (ctx, args) => inferBook(ctx, args),
  },
  {
    name: "sera.market_health",
    title: "Corridor quotability check",
    description:
      "Quick yes/no on whether a corridor is quotable right now. Fires a single $1 simulate quote and returns one of: quotable, no_liquidity, unknown_pair, error. Cheaper than burning a full quote when you only need pre-flight gating.",
    inputSchema: MarketHealthInput,
    outputSchema: MarketHealthOutput,
    annotations: ANN.read("Market health"),
    category: "liquidity",
    handler: (ctx, args) => marketHealth(ctx, args),
  },
  {
    name: "sera.fx_quote_diff",
    title: "Reference vs executable diff",
    description:
      "Compare Sera's reference /fx/rate against the executable rate from a real quote at a chosen notional. Returns deviation in bps so an agent can decide if the displayed mid is close enough to the executable price to size a real swap.",
    inputSchema: FxQuoteDiffInput,
    annotations: ANN.read("FX vs quote"),
    category: "liquidity",
    handler: (ctx, args) => fxQuoteDiff(ctx, args),
  },
  {
    name: "sera.compare_corridors",
    title: "Compare source corridors for target output",
    description:
      "Given a target output (currency + amount), rank candidate source currencies by USD-equivalent cost. Treasury planning: 'I need to deliver 5,000 SGD — which of my source assets does it cheapest?'",
    inputSchema: CompareCorridorsInput,
    annotations: ANN.read("Compare corridors"),
    category: "liquidity",
    handler: (ctx, args) => compareCorridors(ctx, args),
  },

  // ─────────────────────────────────────────────────────────── quote_planning
  {
    name: "sera.get_quote",
    title: "Get swap quote (EIP-712 Intent)",
    description:
      "Single-use Sera swap quote. Returns route_params (EIP-712 Intent) for the agent to sign + uuid + fee breakdown. Pass simulate:true to probe with the burn address (no execution possible). Enforces server policy (whitelist, recipient, max notional, slippage). Quotes embed gas via gas_mode.",
    inputSchema: GetQuoteInput,
    annotations: ANN.quote("Get quote"),
    category: "quote_planning",
    handler: (ctx, args) => getQuote(ctx, args),
  },
  {
    name: "sera.prepare_swap",
    title: "Prepare swap (alias of get_quote)",
    description:
      "Alias of get_quote intended for execution-track flows. Same policy gates apply. Use this name in agent prompts when intent is clearly 'about to execute' vs 'just price discovery'.",
    inputSchema: PrepareSwapInput,
    annotations: ANN.quote("Prepare swap"),
    category: "quote_planning",
    handler: (ctx, args) => prepareSwap(ctx, args),
  },
  {
    name: "sera.quote_recipient_amount",
    title: "Inverse quote: required input for target output",
    description:
      "Inverse: 'I want them to receive exactly X of currency B — what do I send of currency A?' Uses /fx/rate then two real quotes to tighten. Does NOT execute.",
    inputSchema: QuoteRecipientAmountInput,
    annotations: ANN.quote("Inverse quote"),
    category: "quote_planning",
    handler: (ctx, args) => quoteRecipientAmount(ctx, args),
  },
  {
    name: "sera.find_cheapest_settlement_path",
    title: "Find cheapest settlement path",
    description:
      "Compare gas-mode candidates (receive_less vs pay_more) for one A→B and rank by min_output. Use for planning; each candidate consumes its own UUID.",
    inputSchema: FindCheapestPathInput,
    annotations: ANN.quote("Cheapest path"),
    category: "quote_planning",
    handler: (ctx, args) => findCheapestPath(ctx, args),
  },
  {
    name: "sera.limit_watcher",
    title: "Patient limit-quote watcher",
    description:
      "Patient quote: poll /swap/quote on a fixed budget until target_rate hit (or budget exhausted). Sera has no native limit orders — this is a poor-man's version. Default 5 attempts × 6s = ~30s blocking. Returns hit:true with last quote OR hit:false with probe history.",
    inputSchema: LimitWatcherInput,
    annotations: ANN.quote("Limit watcher"),
    category: "quote_planning",
    handler: (ctx, args) => limitWatcher(ctx, args),
  },

  // ─────────────────────────────────────────────────────────────── treasury
  {
    name: "sera.get_balances",
    title: "Wallet + Vault balances",
    description:
      "Wallet + Vault balances for a wallet. Requires SERA_API_KEY/SERA_API_SECRET on the server. Output is normalized to human amounts.",
    inputSchema: GetBalancesInput,
    annotations: ANN.read("Balances"),
    category: "treasury",
    handler: (ctx, args) => getBalances(ctx, args),
  },
  {
    name: "sera.treasury_value",
    title: "Treasury value across wallets",
    description:
      "Aggregate balances across one or more wallets and value the portfolio in target_currency. Returns per-wallet rows + currency exposure breakdown. Requires SERA_API_KEY.",
    inputSchema: TreasuryValueInput,
    annotations: ANN.read("Treasury value"),
    category: "treasury",
    handler: (ctx, args) => treasuryValue(ctx, args),
  },
  {
    name: "sera.exposure_report",
    title: "Currency exposure snapshot",
    description:
      "Slimmer cousin of treasury_value: just the currency mix and total. Use pre-trade ('am I over-exposed to MYR?').",
    inputSchema: ExposureReportInput,
    annotations: ANN.read("Exposure"),
    category: "treasury",
    handler: (ctx, args) => exposureReport(ctx, args),
  },
  {
    name: "sera.rebalance_plan",
    title: "Rebalance to target weights (planner)",
    description:
      "Given target weights (by fiat code) and current balances, emit a list of suggested swaps to rebalance. PURE PLANNER — does not execute. Each suggested trade can be fed into get_quote.",
    inputSchema: RebalancePlanInput,
    annotations: ANN.pureRead("Rebalance plan"),
    category: "treasury",
    handler: (ctx, args) => rebalancePlan(ctx, args),
  },
  {
    name: "sera.pay_invoice",
    title: "Cheapest path to pay an invoice (planner)",
    description:
      "'I owe X of currency Y to address Z — given my source assets, what's the cheapest path?' Fans out across each candidate source and ranks by USD-equivalent cost.",
    inputSchema: PayInvoiceInput,
    annotations: ANN.read("Pay invoice"),
    category: "treasury",
    handler: (ctx, args) => payInvoice(ctx, args),
  },
  {
    name: "sera.settlement_status",
    title: "Sera orders / settlement status",
    description:
      "Query Sera /orders for trade history or a specific trade. Filter by trade_id, uuid, owner_address, status, limit. Requires SERA_API_KEY/SERA_API_SECRET — surfaces a clear gate when missing.",
    inputSchema: SettlementStatusInput,
    annotations: ANN.read("Settlement status"),
    category: "treasury",
    handler: (ctx, args) => settlementStatus(ctx, args ?? {}),
  },

  // ──────────────────────────────────────────────────────────────── history
  {
    name: "sera.fx_history",
    title: "Local FX history",
    description:
      "Sera /fx/rate observations logged by THIS MCP since since_hours_ago. Requires SERA_HISTORY_DB env to be set. Sera doesn't publish OHLC — over time, the MCP becomes its own price feed.",
    inputSchema: FxHistoryInput,
    annotations: ANN.localRead("FX history"),
    category: "history",
    handler: (_ctx, args) => fxHistory(args),
  },
  {
    name: "sera.fx_volatility",
    title: "FX volatility stats",
    description:
      "Stats over fx_history window: mean, stdev, range_bps, annualized vol estimate. Requires SERA_HISTORY_DB.",
    inputSchema: FxHistoryInput,
    annotations: ANN.localRead("FX volatility"),
    category: "history",
    handler: (_ctx, args) => fxVolatility(args),
  },
  {
    name: "sera.corridor_pnl",
    title: "Corridor PnL (mark-to-market)",
    description:
      "What would holding the long side of this pair have realized over the window? Mark-to-market based on logged Sera /fx/rate; doesn't include swap costs. Requires SERA_HISTORY_DB.",
    inputSchema: FxHistoryInput,
    annotations: ANN.localRead("Corridor PnL"),
    category: "history",
    handler: (_ctx, args) => corridorPnl(args),
  },

  // ────────────────────────────────────────────────────────────── execution
  {
    name: "sera.execute_swap",
    title: "Submit signed swap (DESTRUCTIVE)",
    description:
      "Submit a signed swap quote (uuid + EIP-712 signature) to Sera. External signer mode: agent provides signature. Local mode: server signs route_params. Quotes are single-use — handle QUOTE_STALE/410 by re-quoting. Gated by POLICY_DRY_RUN and POLICY_DAILY_VOLUME_CAP_USD when set.",
    inputSchema: ExecuteSwapInput,
    annotations: ANN.destructive("Execute swap"),
    category: "execution",
    handler: (ctx, args) => executeSwap(ctx, args),
  },
  {
    name: "sera.convert_and_send",
    title: "Quote + execute + deliver (DESTRUCTIVE, local-signer only)",
    description:
      "High-level: quote A→B and deliver to recipient in one call. Requires SERA_SIGNER_MODE=local. For external signer, use get_quote → wallet sign → execute_swap.",
    inputSchema: ConvertAndSendInput,
    annotations: ANN.destructive("Convert and send"),
    category: "execution",
    handler: (ctx, args) => convertAndSend(ctx, args),
  },

  // ──────────────────────────────────────────────────────────────── account
  // tx builders return unsigned EIP-1559 transactions; the matching send_*
  // tool broadcasts the locally-signed raw_tx.
  {
    name: "sera.build_approve",
    title: "Build ERC-20 approve tx",
    description:
      "Build an unsigned EIP-1559 ERC-20 approve() transaction. Returns `tx` object — sign locally with the owner wallet, then broadcast via sera.send_tx. `spender` must be the live vault_address or sor_address (read from sera://config). Requires SERA_API_KEY.",
    inputSchema: BuildApproveInput,
    annotations: ANN.read("Build approve"),
    category: "account",
    handler: (ctx, args) => buildApprove(ctx, args),
  },
  {
    name: "sera.build_deposit",
    title: "Build vault deposit tx (optionally with EIP-2612 permit)",
    description:
      "Build an unsigned deposit transaction. Omit permit_* fields for the standard depositFund flow (requires prior approve); include them to combine approval + deposit via depositFundWithPermit in one tx. Returns `tx` — sign locally, broadcast via sera.send_tx. Requires SERA_API_KEY.",
    inputSchema: BuildDepositInput,
    annotations: ANN.read("Build deposit"),
    category: "account",
    handler: (ctx, args) => buildDeposit(ctx, args),
  },
  {
    name: "sera.build_transfer",
    title: "Build ERC-20 transfer tx",
    description:
      "Build an unsigned ERC-20 transfer() transaction. Returns `tx` — sign locally, broadcast via sera.send_transfer. Requires SERA_API_KEY.",
    inputSchema: BuildTransferInput,
    annotations: ANN.read("Build transfer"),
    category: "account",
    handler: (ctx, args) => buildTransfer(ctx, args),
  },
  {
    name: "sera.send_tx",
    title: "Broadcast signed approve/deposit tx (DESTRUCTIVE)",
    description:
      "Broadcast a locally-signed raw_tx returned from sera.build_approve or sera.build_deposit. Sera validates the selector-to-target pairing; transfers go through sera.send_transfer instead. Returns `tx_hash`. Requires SERA_API_KEY.",
    inputSchema: SendTxInput,
    annotations: ANN.destructive("Send tx"),
    category: "account",
    handler: (ctx, args) => sendTx(ctx, args),
  },
  {
    name: "sera.send_transfer",
    title: "Broadcast signed transfer tx (DESTRUCTIVE)",
    description:
      "Broadcast a locally-signed raw_tx returned from sera.build_transfer. Returns `tx_hash`. Requires SERA_API_KEY.",
    inputSchema: SendTransferInput,
    annotations: ANN.destructive("Send transfer"),
    category: "account",
    handler: (ctx, args) => sendTransfer(ctx, args),
  },

  // ─────────────────────────────────────────────────────── withdraw (dual-sig)
  // 4-step flow:
  //   1. sera.withdraw_request — user signs WithdrawIntent; executor co-signs.
  //   2. sera.withdraw_build   — server builds unsigned tx with both sigs.
  //   3. (off-server) user signs the tx locally.
  //   4. sera.withdraw_send    — broadcast.
  {
    name: "sera.withdraw_request",
    title: "Withdraw step 1: request executor co-signature",
    description:
      "Step 1 of the dual-signature instant-withdrawal flow. User pre-signs a WithdrawIntent under the Sera EIP-712 domain; this endpoint returns the executor co-signature. Continue to sera.withdraw_build with both signatures.",
    inputSchema: WithdrawRequestInput,
    annotations: ANN.read("Withdraw cosign"),
    category: "withdraw",
    handler: (ctx, args) => withdrawRequest(ctx, args),
  },
  {
    name: "sera.withdraw_build",
    title: "Withdraw step 2: build unsigned tx",
    description:
      "Step 2 of dual-sig withdraw. Given the WithdrawIntent + user signature + executor co-signature, returns the unsigned executeInstantWithdrawDualSig transaction. Sign locally; broadcast via sera.withdraw_send.",
    inputSchema: WithdrawBuildInput,
    annotations: ANN.read("Withdraw build"),
    category: "withdraw",
    handler: (ctx, args) => withdrawBuild(ctx, args),
  },
  {
    name: "sera.withdraw_send",
    title: "Withdraw step 4: broadcast signed tx (DESTRUCTIVE)",
    description:
      "Step 4 of dual-sig withdraw. Broadcast the locally-signed executeInstantWithdrawDualSig raw_tx. Sera validates selector-to-target pairing; only accepts calls targeting the live Sera contract.",
    inputSchema: WithdrawSendInput,
    annotations: ANN.destructive("Withdraw send"),
    category: "withdraw",
    handler: (ctx, args) => withdrawSend(ctx, args),
  },

  // ────────────────────────────────────────────────────────────── debugging
  {
    name: "sera.batch_quote",
    title: "Batch swap quotes (up to 50 in one round-trip)",
    description:
      "Replaces client-side fan-out with Sera's POST /swap/quote/batch. Submit 1–50 quote requests at once; each gets its own uuid and signed Intent. Per-item errors surface as { ok:false, error:{...} } without failing the batch. Useful for makers pricing many pairs.",
    inputSchema: BatchQuoteInput,
    annotations: ANN.quote("Batch quote"),
    category: "quote_planning",
    handler: (ctx, args) => batchQuote(ctx, args),
  },
  {
    name: "sera.verify_signature",
    title: "Test EIP-712 signature without placing an order",
    description:
      "Round-trips a signed payload through Sera's /verify-signature endpoint. Useful for diagnosing wallet-side signing issues (wrong domain, malformed typed-data, mismatched uuid_int) before burning a quote on a failed POST /orders.",
    inputSchema: VerifySignatureInput,
    annotations: ANN.read("Verify signature"),
    category: "debugging",
    handler: (ctx, args) => verifySignature(ctx, args as Record<string, unknown>),
  },
  {
    name: "sera.permit_metadata",
    title: "Check EIP-2612 permit support for a token",
    description:
      "Returns whether the token supports EIP-2612 (`permit_supported`), the current allowance for owner→spender, and — if supported — the EIP-2612 domain + next nonce. Use to decide between sera.build_approve (no-permit) and sera.build_deposit with permit_signature.",
    inputSchema: PermitMetadataInput,
    annotations: ANN.read("Permit metadata"),
    category: "debugging",
    handler: (ctx, args) => permitMetadata(ctx, args),
  },

  // ────────────────────────────────────────────────────────────────── maker
  // Order placement, cancellation, listing. Write paths require the agent to
  // sign Order / CancelOrder / CancelVLBatch structs as EIP-712 under the
  // Sera domain. The MCP forwards as-is — no server-side signing for makers
  // in this release (planned for a future sprint alongside local-signer maker
  // workflows).
  {
    name: "sera.place_order",
    title: "Place limit order (DESTRUCTIVE — agent-signed)",
    description:
      "Submit a signed limit order to Sera. Agent picks order_id (UUID4), constructs uuid_int with the current executor_id (read once via sera.doctor at startup), signs the Order struct under the Sera EIP-712 domain, and submits. Order ID returned; track via sera.get_order. POST /orders is idempotent on order_id — safe to retry on network error.",
    inputSchema: PlaceOrderInput,
    annotations: ANN.destructive("Place order"),
    category: "maker",
    handler: (ctx, args) => placeOrder(ctx, args),
  },
  {
    name: "sera.cancel_order",
    title: "Cancel a single limit order (signed)",
    description:
      "Cancel an existing order by signing a CancelOrder struct (owner + composite uuid_int). 5-minute per-order cancel cooldown — repeated cancels of the same order_id within 5min return 429. Note: a 200 means the matching engine accepted the cancel; in-flight fills may still settle on-chain. Poll sera.get_order until settlement_summary terminalizes before clearing local state.",
    inputSchema: CancelOrderInput,
    annotations: ANN.destructive("Cancel order"),
    category: "maker",
    handler: (ctx, args) => cancelOrder(ctx, args),
  },
  {
    name: "sera.cancel_all_orders",
    title: "Cancel all open orders (API Key, DESTRUCTIVE)",
    description:
      "Bulk-cancel every open order for the authenticated wallet. Returns lists of cancelled / failed / skipped_cooldown order IDs. Useful for kill-switch / pause-trading workflows.",
    inputSchema: CancelAllOrdersInput,
    annotations: ANN.destructive("Cancel all"),
    category: "maker",
    handler: (ctx, args) => cancelAllOrders(ctx, args),
  },
  {
    name: "sera.place_vl_batch",
    title: "Place Virtual Liquidity batch (DESTRUCTIVE — multi-pair, capital-efficient)",
    description:
      "Submit 2–50 signed limit orders sharing one collateral pool. The matching engine freezes only the LARGEST single-leg cost, not the sum — quote many pairs from a single budget. All siblings must share owner_address and fromToken; uuid_int's share a VL group_id with sequential leg_id's (0, 1, 2…). Active cap from sera://config → limits.vl_batch.max.",
    inputSchema: PlaceVlBatchInput,
    annotations: ANN.destructive("Place VL batch"),
    category: "maker",
    handler: (ctx, args) => placeVlBatch(ctx, args),
  },
  {
    name: "sera.cancel_vl_batch",
    title: "Cancel a VL batch (signed)",
    description:
      "Cancel an entire Virtual Liquidity batch by signing a CancelVLBatch struct against the batch's vl_batch_id (primary_id of the first leg).",
    inputSchema: CancelVlBatchInput,
    annotations: ANN.destructive("Cancel VL batch"),
    category: "maker",
    handler: (ctx, args) => cancelVlBatch(ctx, args),
  },
  {
    name: "sera.get_order",
    title: "Fetch a single order (API Key)",
    description:
      "Returns the full order record including settlement_summary (per-fill aggregation) and settlement_economics (gross vs balance debits/credits, fees_paid). Use to track fills after sera.place_order or to recover a lost uuid_int.",
    inputSchema: GetOrderInput,
    annotations: ANN.read("Get order"),
    category: "maker",
    handler: (ctx, args) => getOrder(ctx, args),
  },
  {
    name: "sera.list_orders",
    title: "List orders with rich filters (API Key)",
    description:
      "Rich filtering over the wallet's order history: status, type, symbol, side, price/amount/notional ranges, time bounds, sort. limit max 500. Filters apply BEFORE pagination (so `total` reflects the full filtered set). For a single order use sera.get_order.",
    inputSchema: ListOrdersInput,
    annotations: ANN.read("List orders"),
    category: "maker",
    handler: (ctx, args) => listOrders(ctx, args),
  },
  {
    name: "sera.get_fills",
    title: "Fills across orders (API Key)",
    description:
      "Per-fill list (maker_order_id + taker_order_id + quantity + price + settlement_status + tx_hash + settlement_economics) filterable by order_status / settlement_status. For a single order's fills use sera.get_fills_for_order.",
    inputSchema: GetFillsInput,
    annotations: ANN.read("Get fills"),
    category: "maker",
    handler: (ctx, args) => listFills(ctx, args),
  },
  {
    name: "sera.get_fills_for_order",
    title: "Fills for one order (API Key)",
    description:
      "All fills against a specific order_id with per-fill settlement_economics.",
    inputSchema: GetFillsForOrderInput,
    annotations: ANN.read("Get fills for order"),
    category: "maker",
    handler: (ctx, args) => getFillsForOrder(ctx, args),
  },
];

/**
 * Group lookup. Used by createServer to filter tools when the future
 * SERA_ENABLE_EXECUTION_TOOLS gate is off.
 */
export const TOOLS_BY_CATEGORY: Record<ToolCategory, ToolDef[]> = TOOLS.reduce(
  (acc, t) => {
    (acc[t.category] ||= []).push(t);
    return acc;
  },
  {} as Record<ToolCategory, ToolDef[]>,
);

