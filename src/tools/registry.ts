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

import { z, type ZodTypeAny } from "zod";

import type { AppContext } from "../config.js";

import {
  CompareCorridorsInput,
  CompareToExternalFxInput,
  ConvertAndSendInput,
  DoctorInput,
  ExecuteSwapInput,
  ExposureReportInput,
  FindCheapestPathInput,
  FindDealsInput,
  FxHistoryInput,
  FxQuoteDiffInput,
  GetBalancesInput,
  GetFxRateInput,
  GetMarketsInput,
  GetQuoteInput,
  InferBookInput,
  LimitWatcherInput,
  ListCurrenciesInput,
  MakerQuoteLadderInput,
  MarketHealthInput,
  MultiSourceMidInput,
  PayInvoiceInput,
  PrepareSwapInput,
  ProbeDepthInput,
  QuoteRecipientAmountInput,
  RebalancePlanInput,
  RoundTripCostInput,
  ScanMarketsInput,
  SettlementStatusInput,
  SpreadRadarInput,
  TreasuryValueInput,
} from "./schemas.js";

import {
  executeSwap,
  getBalances,
  getFxRate,
  getMarkets,
  getQuote,
  listCurrencies,
  prepareSwap,
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
import { doctor } from "./admin.js";
import { findDeals } from "./deals.js";
import { makerQuoteLadder, multiSourceMid } from "./maker.js";
import { limitWatcher } from "./watcher.js";
import { settlementStatus } from "./settlement.js";
import {
  marketHealth,
  fxQuoteDiff,
  compareCorridors,
} from "./health_corridors.js";

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
  | "execution";

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
    name: "sera.doctor",
    title: "Server self-check",
    description:
      "One-call self-check: API health, network sanity, signer mode, policy summary, persistence state. Use for quick 'is everything wired right' debugging.",
    inputSchema: DoctorInput,
    annotations: ANN.read("Doctor"),
    category: "discovery",
    handler: (ctx) => doctor(ctx),
  },

  // ──────────────────────────────────────────────────────────────── pricing
  {
    name: "sera.get_fx_rate",
    title: "Sera FX rate",
    description:
      "Sera's reference FX rate between two ISO currency codes (e.g. base='SGD', quote='USD'). Has measurable bid/ask asymmetry — for execution price, always use sera.get_quote. To detect Sera vs market bias, pair with sera.compare_to_external_fx. Cached 60s server-side.",
    inputSchema: GetFxRateInput,
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

/** Suppress unused import — kept for downstream consumers and JSDoc clarity. */
export type _Z = z.ZodType;
