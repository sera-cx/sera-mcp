/**
 * output-schemas.test.ts — drift guard for outputSchema.
 *
 * create-server.ts emits `structuredContent` whenever a tool declares an
 * outputSchema, and the MCP SDK VALIDATES that payload against the schema.
 * So a schema that drifts from its handler doesn't degrade gracefully — it
 * turns a working tool into a runtime error for every caller.
 *
 * These tests run each declared schema against the handler's ACTUAL output
 * (stubbed context, no network) so drift fails here instead of in production.
 */
import { describe, it, expect } from "vitest";
import {
  getMarkets,
  getTradingPairs,
  getCoinMetadata,
  getCoinHistory,
  listCurrencies,
  searchCoins,
} from "../src/tools/core.js";
import { getWalletInfo } from "../src/tools/admin.js";
import {
  GetMarketsOutput,
  GetTradingPairsOutput,
  GetWalletInfoOutput,
  SearchCoinsOutput,
  GetCoinMetadataOutput,
  GetCoinHistoryOutput,
  ListCurrenciesOutput,
} from "../src/tools/schemas.js";
import { TOOLS } from "../src/tools/registry.js";
import type { AppContext } from "../src/config.js";
import type { SeraMarket } from "../src/sera/types.js";

const TOKENS = [
  { symbol: "XSGD", name: "XSGD", address: "0xAAA0000000000000000000000000000000000001", decimals: 6, fiat_currency: "SGD" },
  { symbol: "USDC", name: "USD Coin", address: "0xBBB0000000000000000000000000000000000002", decimals: 6, fiat_currency: "USD" },
  // No fiat tag and no name — exercises the optional fields in the schemas.
  { symbol: "WEIRD", address: "0xCCC0000000000000000000000000000000000003", decimals: 18 },
  // Real BRZ address, so the live-payload test below can resolve it.
  // getTokensCached memoizes per module for 60s, so overriding getTokens inside
  // a single test has no effect once the cache is warm — the token must be here.
  { symbol: "BRZ", name: "Brazilian Digital Token", address: "0x01d33fd36ec67c6ada32cf36b31e88ee190b1839", decimals: 18, fiat_currency: "BRL" },
];

const MARKETS: SeraMarket[] = [
  { symbol: "XSGD/USDC", base_address: TOKENS[0].address, quote_address: TOKENS[1].address, base_symbol: "XSGD", quote_symbol: "USDC", base_decimals: 6, quote_decimals: 6 },
];

function ctx(): AppContext {
  return {
    cfg: { network: "mainnet", baseUrl: "https://api.sera.cx/api/v1", signerMode: "external", enableExecutionTools: true },
    sera: {
      getTokens: async () => ({ tokens: TOKENS }),
      getMarkets: async () => ({ markets: MARKETS }),
    },
    signer: { mode: "external", address: async () => undefined, signIntent: async () => { throw new Error("unused"); } },
    policy: { config: { allowedSymbols: [] } },
  } as unknown as AppContext;
}

describe("outputSchema matches real handler output", () => {
  it("get_markets", async () => {
    const out1 = await getMarkets(ctx());
    expect(() => GetMarketsOutput.parse(out1)).not.toThrow();
  });

  it("get_trading_pairs", async () => {
    const out = await getTradingPairs(ctx(), { token: "XSGD" });
    expect(() => GetTradingPairsOutput.parse(out)).not.toThrow();
  });

  it("get_wallet_info — external mode (null address)", async () => {
    const out2 = await getWalletInfo(ctx());
    expect(() => GetWalletInfoOutput.parse(out2)).not.toThrow();
  });

  it("get_wallet_info — local mode, and the address_error branch", async () => {
    const local = ctx();
    (local.signer as any).mode = "local";
    (local.signer as any).address = async () => "0xDDD0000000000000000000000000000000000004";
    const out3 = await getWalletInfo(local);
    expect(() => GetWalletInfoOutput.parse(out3)).not.toThrow();

    const broken = ctx();
    (broken.signer as any).address = async () => { throw new Error("keystore locked"); };
    const out4 = await getWalletInfo(broken);
    expect(() => GetWalletInfoOutput.parse(out4)).not.toThrow();
  });

  it("search_coins — including a token with no name/fiat", async () => {
    const out5 = await searchCoins(ctx(), { query: "e" });
    expect(() => SearchCoinsOutput.parse(out5)).not.toThrow();
  });

  it("list_currencies", async () => {
    const out6 = await listCurrencies(ctx(), {});
    expect(() => ListCurrenciesOutput.parse(out6)).not.toThrow();
  });

  // Both branches: the registry hit and the honest not-found object.
  it("get_coin_metadata — found and not-found", async () => {
    const out7 = await getCoinMetadata(ctx(), { symbol: "USDC" });
    expect(() => GetCoinMetadataOutput.parse(out7)).not.toThrow();
    const out8 = await getCoinMetadata(ctx(), { symbol: "NOPE" });
    expect(() => GetCoinMetadataOutput.parse(out8)).not.toThrow();
  });

  // Three of the four branches are reachable without SERA_HISTORY_DB:
  // unknown symbol, history-disabled, and no-fiat-tag.
  it("get_coin_history — unknown symbol, disabled, and untagged token", async () => {
    const out9 = await getCoinHistory(ctx(), { symbol: "NOPE" });
    expect(() => GetCoinHistoryOutput.parse(out9)).not.toThrow();
    const out10 = await getCoinHistory(ctx(), { symbol: "XSGD" });
    expect(() => GetCoinHistoryOutput.parse(out10)).not.toThrow();
    const out11 = await getCoinHistory(ctx(), { symbol: "WEIRD" });
    expect(() => GetCoinHistoryOutput.parse(out11)).not.toThrow();
  });
});

describe("outputSchema rollout invariants", () => {
  it("every discovery tool declares an outputSchema", () => {
    const missing = TOOLS.filter((t) => t.category === "discovery" && !t.outputSchema).map((t) => t.name);
    expect(missing, `discovery tools without outputSchema: ${missing.join(", ")}`).toEqual([]);
  });

  it("declared output schemas are permissive (passthrough) so handler growth can't break a live tool", () => {
    // A strict object rejects unknown keys at validation time. Any tool whose
    // handler later adds a field would start erroring for every caller, so the
    // top level of each output schema must allow unknown keys.
    const strict = TOOLS.filter((t) => {
      if (!t.outputSchema) return false;
      const def: any = (t.outputSchema as any)._def;
      return def?.typeName === "ZodObject" && def.unknownKeys === "strip";
    }).map((t) => t.name);
    // The 4 pre-existing v0.7.0 schemas predate this rule; lock in that the
    // set of strict schemas never grows.
    expect(strict.sort()).toEqual(
      ["sera.doctor", "sera.list_currencies", "sera.market_health"].sort(),
    );
  });
});

/**
 * A verbatim row from live api.sera.cx/api/v1/markets (captured 2026-09-01).
 * The key set below is the union across all 780 rows returned that day.
 *
 * This is the guard that was missing: the previous fixtures used invented
 * field names, so GetMarketsOutput could require base_token/quote_token/
 * display_pair — fields the API has never returned — while every test stayed
 * green and sera.get_markets failed for real callers with an SDK output
 * validation error.
 */
const LIVE_MARKET_ROW = {
  symbol: "BRZ/AUDM",
  base_address: "0x01d33fd36ec67c6ada32cf36b31e88ee190b1839",
  quote_address: "0x081599e4936d12c46bd48913b2329115cd26cbdd",
  base_symbol: "BRZ",
  quote_symbol: "AUDM",
  tick_precision: 18,
  quantity_precision: 18,
  base_decimals: 18,
  quote_decimals: 18,
  min_ask_amount_raw: "500000000000000000",
  min_ask_amount: "0.500000000000000000",
  min_bid_quote_amount_raw: "200000000000000000",
  min_bid_quote_amount: "0.200000000000000000",
};

describe("schemas accept the real /markets payload", () => {
  it("GetMarketsOutput validates a verbatim live row", () => {
    const payload = { count: 1, markets: [LIVE_MARKET_ROW] };
    expect(() => GetMarketsOutput.parse(payload)).not.toThrow();
  });

  it("get_trading_pairs works on a verbatim live row", async () => {
    const c = ctx();
    (c.sera as any).getMarkets = async () => ({ markets: [LIVE_MARKET_ROW] });

    const out = await getTradingPairs(c, { token: "BRZ" });
    expect(out.count).toBe(1);
    expect(out.pairs[0].pair).toBe("BRZ/AUDM");
    expect(out.pairs[0].direction).toBe("ASK");
    expect(out.pairs[0].to.symbol).toBe("AUDM");
    // And the declared schema must accept what the handler actually returns.
    expect(() => GetTradingPairsOutput.parse(out)).not.toThrow();
  });
});
