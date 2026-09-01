/**
 * ported-tools.test.ts — behavior tests for the tools ported from sera-mcp-v2.
 *
 * Covers sera.get_trading_pairs and sera.get_wallet_info. Both are pure
 * functions of injected context (no live network), so we stub SeraClient and
 * Signer rather than hitting the API.
 */
import { describe, it, expect } from "vitest";
import { getTradingPairs } from "../src/tools/core.js";
import { getWalletInfo } from "../src/tools/admin.js";
import type { AppContext } from "../src/config.js";
import type { SeraMarket } from "../src/sera/types.js";

const TOKENS = [
  { symbol: "XSGD", name: "XSGD", address: "0xAAA0000000000000000000000000000000000001", decimals: 6, fiat_currency: "SGD" },
  { symbol: "USDC", name: "USD Coin", address: "0xBBB0000000000000000000000000000000000002", decimals: 6, fiat_currency: "USD" },
  { symbol: "EURC", name: "Euro Coin", address: "0xCCC0000000000000000000000000000000000003", decimals: 6, fiat_currency: "EUR" },
];

// Typed as SeraMarket so a drift between these fixtures and the real /markets
// shape is a compile error. These previously used base_token/quote_token/
// display_pair — names the API has never returned — which is exactly why the
// suite stayed green while both tools failed against production.
const MARKETS: SeraMarket[] = [
  // XSGD on the base side -> selling XSGD is an ASK.
  { symbol: "XSGD/USDC", base_address: TOKENS[0].address, quote_address: TOKENS[1].address, base_symbol: "XSGD", quote_symbol: "USDC", base_decimals: 6, quote_decimals: 6 },
  // XSGD on the quote side -> leaving XSGD is a BID.
  { symbol: "EURC/XSGD", base_address: TOKENS[2].address, quote_address: TOKENS[0].address, base_symbol: "EURC", quote_symbol: "XSGD", base_decimals: 6, quote_decimals: 6 },
  // Unrelated pair — must be filtered out.
  { symbol: "USDC/EURC", base_address: TOKENS[1].address, quote_address: TOKENS[2].address, base_symbol: "USDC", quote_symbol: "EURC", base_decimals: 6, quote_decimals: 6 },
];

function ctxWith(overrides: Partial<AppContext> = {}): AppContext {
  return {
    cfg: {
      network: "mainnet",
      baseUrl: "https://api.sera.cx/api/v1",
      signerMode: "external",
      enableExecutionTools: true,
    },
    sera: {
      getTokens: async () => ({ tokens: TOKENS }),
      getMarkets: async () => ({ markets: MARKETS }),
    },
    signer: {
      mode: "external",
      address: async () => undefined,
      signIntent: async () => {
        throw new Error("not used");
      },
    },
    policy: { config: { allowedSymbols: [] } },
    ...overrides,
  } as unknown as AppContext;
}

describe("get_trading_pairs", () => {
  it("returns only markets touching the token, with the correct side", async () => {
    const res = await getTradingPairs(ctxWith(), { token: "XSGD" });

    expect(res.count).toBe(2);
    expect(res.pairs.map((p) => p.pair).sort()).toEqual(["EURC/XSGD", "XSGD/USDC"]);

    const ask = res.pairs.find((p) => p.pair === "XSGD/USDC")!;
    expect(ask.direction).toBe("ASK");
    expect(ask.from.symbol).toBe("XSGD");
    expect(ask.to.symbol).toBe("USDC");

    const bid = res.pairs.find((p) => p.pair === "EURC/XSGD")!;
    expect(bid.direction).toBe("BID");
    // Leaving XSGD means XSGD is always the `from` side, whichever side of the
    // book it sits on. This is the invariant the direction flag exists to hold.
    expect(bid.from.symbol).toBe("XSGD");
    expect(bid.to.symbol).toBe("EURC");
  });

  it("resolves a 0x address as well as a symbol", async () => {
    const bySymbol = await getTradingPairs(ctxWith(), { token: "XSGD" });
    const byAddress = await getTradingPairs(ctxWith(), { token: TOKENS[0].address });
    expect(byAddress.count).toBe(bySymbol.count);
    expect(byAddress.token.symbol).toBe("XSGD");
  });

  it("resolves a fiat tag", async () => {
    const res = await getTradingPairs(ctxWith(), { token: "SGD" });
    expect(res.token.symbol).toBe("XSGD");
    expect(res.count).toBe(2);
  });

  it("returns an empty list (not an error) for a token with no markets", async () => {
    const ctx = ctxWith();
    (ctx.sera as any).getMarkets = async () => ({ markets: [] });
    const res = await getTradingPairs(ctx, { token: "XSGD" });
    expect(res.count).toBe(0);
    expect(res.pairs).toEqual([]);
  });

  it("throws on an unknown token rather than returning empty", async () => {
    await expect(getTradingPairs(ctxWith(), { token: "NOPE" })).rejects.toThrow();
  });
});

describe("get_wallet_info", () => {
  it("reports a null address in external mode without erroring", async () => {
    const res = await getWalletInfo(ctxWith());
    expect(res.signer_mode).toBe("external");
    expect(res.address).toBeNull();
    expect(res.can_sign).toBe(false);
    expect(res).not.toHaveProperty("address_error");
  });

  it("reports the resolved address in local mode", async () => {
    const ctx = ctxWith();
    (ctx.signer as any).mode = "local";
    (ctx.signer as any).address = async () => "0xDDD0000000000000000000000000000000000004";
    const res = await getWalletInfo(ctx);
    expect(res.signer_mode).toBe("local");
    expect(res.address).toBe("0xDDD0000000000000000000000000000000000004");
    expect(res.can_sign).toBe(true);
  });

  it("surfaces a signer failure as address_error instead of throwing", async () => {
    const ctx = ctxWith();
    (ctx.signer as any).address = async () => {
      throw new Error("keystore locked");
    };
    const res = await getWalletInfo(ctx);
    expect(res.address).toBeNull();
    expect(res.address_error).toContain("keystore locked");
  });

  it("never reports a gas balance — this server holds no RPC", async () => {
    const res = await getWalletInfo(ctxWith());
    expect(res).not.toHaveProperty("balance_eth");
  });
});
