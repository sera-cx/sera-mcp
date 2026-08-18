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

const TOKENS = [
  { symbol: "XSGD", name: "XSGD", address: "0xAAA0000000000000000000000000000000000001", decimals: 6, fiat_currency: "SGD" },
  { symbol: "USDC", name: "USD Coin", address: "0xBBB0000000000000000000000000000000000002", decimals: 6, fiat_currency: "USD" },
  // No fiat tag and no name — exercises the optional fields in the schemas.
  { symbol: "WEIRD", address: "0xCCC0000000000000000000000000000000000003", decimals: 18 },
];

const MARKETS = [
  { base_token: TOKENS[0].address, quote_token: TOKENS[1].address, base_symbol: "XSGD", quote_symbol: "USDC", display_pair: "XSGD/USDC" },
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
