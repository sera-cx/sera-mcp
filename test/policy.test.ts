import { describe, it, expect } from "vitest";
import { PolicyEngine, PRESETS, guessFiatFromSymbol, type PolicyConfig } from "../src/policy/policy.js";
import type { SeraClient } from "../src/sera/client.js";
import type { SeraToken } from "../src/sera/types.js";

function makeConfig(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    allowedSymbols: [],
    allowedRecipients: [],
    maxNotionalUsd: 0,
    dailyVolumeCapUsd: 0,
    defaultExpirationSeconds: 120,
    maxExpirationSeconds: 600,
    outputToleranceBps: 0,
    dryRun: false,
    historyHashOwner: true,
    persistentDailyVolume: false,
    ...overrides,
  };
}

function fakeSera(fxRate: number = 1): SeraClient {
  return {
    getFxRate: async (_b: string, _q: string) => ({
      base: _b, quote: _q, rate: String(fxRate),
    }),
  } as any as SeraClient;
}

const tokenUSDC: SeraToken = { symbol: "USDC", address: "0x" + "1".repeat(40), decimals: 6, fiat_currency: "USD" };
const tokenXSGD: SeraToken = { symbol: "XSGD", address: "0x" + "2".repeat(40), decimals: 6, fiat_currency: "SGD" };

describe("PolicyEngine — symbol whitelist", () => {
  it("allows any when whitelist empty", () => {
    const p = new PolicyEngine(makeConfig({ allowedSymbols: [] }), fakeSera());
    expect(p.checkSymbol(tokenUSDC).ok).toBe(true);
    expect(p.checkSymbol(tokenXSGD).ok).toBe(true);
  });

  it("rejects when not in whitelist", () => {
    const p = new PolicyEngine(makeConfig({ allowedSymbols: ["USDC"] }), fakeSera());
    const r = p.checkSymbol(tokenXSGD);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/XSGD not in POLICY_ALLOWED_SYMBOLS/);
  });

  it("is case-insensitive on the configured list", () => {
    const p = new PolicyEngine(makeConfig({ allowedSymbols: ["USDC"] }), fakeSera());
    const t: SeraToken = { ...tokenUSDC, symbol: "usdc" };
    expect(p.checkSymbol(t).ok).toBe(true);
  });
});

describe("PolicyEngine — recipient whitelist", () => {
  it("allows any when whitelist empty", () => {
    const p = new PolicyEngine(makeConfig(), fakeSera());
    expect(p.checkRecipient("0xAAA").ok).toBe(true);
  });

  it("lowercases on compare so EIP-55 checksum passes", () => {
    const lower = "0x" + "a".repeat(40);
    const checksum = "0x" + "A".repeat(40);
    const p = new PolicyEngine(makeConfig({ allowedRecipients: [lower] }), fakeSera());
    expect(p.checkRecipient(checksum).ok).toBe(true);
  });

  it("rejects when not in whitelist", () => {
    const lower = "0x" + "a".repeat(40);
    const other = "0x" + "b".repeat(40);
    const p = new PolicyEngine(makeConfig({ allowedRecipients: [lower] }), fakeSera());
    expect(p.checkRecipient(other).ok).toBe(false);
  });
});

describe("PolicyEngine — dry run", () => {
  it("returns ok when dryRun off", () => {
    const p = new PolicyEngine(makeConfig({ dryRun: false }), fakeSera());
    expect(p.checkDryRun().ok).toBe(true);
  });
  it("refuses when dryRun on", () => {
    const p = new PolicyEngine(makeConfig({ dryRun: true }), fakeSera());
    const r = p.checkDryRun();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/POLICY_DRY_RUN/);
  });
});

describe("PolicyEngine — notional cap (per-tx)", () => {
  it("returns ok when cap is 0 (disabled)", async () => {
    const p = new PolicyEngine(makeConfig({ maxNotionalUsd: 0 }), fakeSera());
    expect((await p.checkNotional(tokenUSDC, 1_000_000)).ok).toBe(true);
  });

  it("allows USD-pegged input within cap (no FX lookup)", async () => {
    const p = new PolicyEngine(makeConfig({ maxNotionalUsd: 5000 }), fakeSera());
    expect((await p.checkNotional(tokenUSDC, 1000)).ok).toBe(true);
  });

  it("rejects USD-pegged input above cap", async () => {
    const p = new PolicyEngine(makeConfig({ maxNotionalUsd: 5000 }), fakeSera());
    const r = await p.checkNotional(tokenUSDC, 10000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds POLICY_MAX_NOTIONAL_USD/);
  });

  it("converts non-USD input via fx_rate", async () => {
    // 1 SGD = 0.75 USD; 1000 SGD = $750 < $1000 cap
    const p = new PolicyEngine(makeConfig({ maxNotionalUsd: 1000 }), fakeSera(0.75));
    expect((await p.checkNotional(tokenXSGD, 1000)).ok).toBe(true);
    // 2000 SGD = $1500 > $1000 cap
    expect((await p.checkNotional(tokenXSGD, 2000)).ok).toBe(false);
  });

  it("refuses to bypass cap when fx_rate unreachable", async () => {
    const failingSera = {
      getFxRate: async () => { throw new Error("upstream down"); },
    } as any as SeraClient;
    const p = new PolicyEngine(makeConfig({ maxNotionalUsd: 1000 }), failingSera);
    const r = await p.checkNotional(tokenXSGD, 100);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unable to price/);
  });
});

describe("PolicyEngine — daily volume cap", () => {
  it("ok when cap is 0 (disabled)", () => {
    const p = new PolicyEngine(makeConfig({ dailyVolumeCapUsd: 0 }), fakeSera());
    expect(p.checkDailyVolume(1_000_000).ok).toBe(true);
  });

  it("rejects projected volume above cap", () => {
    const p = new PolicyEngine(makeConfig({ dailyVolumeCapUsd: 5000 }), fakeSera());
    p.recordExecutedNotional(4500);
    const r = p.checkDailyVolume(1000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds POLICY_DAILY_VOLUME_CAP_USD/);
  });

  it("accepts projected volume at cap exactly", () => {
    const p = new PolicyEngine(makeConfig({ dailyVolumeCapUsd: 5000 }), fakeSera());
    p.recordExecutedNotional(4500);
    expect(p.checkDailyVolume(500).ok).toBe(true);
  });

  it("memory-mode rolling 24h returns 0 immediately", () => {
    const p = new PolicyEngine(makeConfig(), fakeSera());
    expect(p.rolling24hVolumeUsd()).toBe(0);
  });
});

describe("PRESETS", () => {
  it("all four documented presets exist", () => {
    for (const name of ["starter", "standard", "sg-retail", "open"]) {
      expect(PRESETS[name]).toBeDefined();
    }
  });

  it("starter is conservative", () => {
    expect(PRESETS.starter.maxNotionalUsd).toBeLessThanOrEqual(1000);
  });

  it("open preset has no caps (and is named loudly)", () => {
    expect(PRESETS.open.maxNotionalUsd).toBe(0);
    expect(PRESETS.open.dailyVolumeCapUsd).toBe(0);
  });
});

describe("guessFiatFromSymbol", () => {
  it("knows common stablecoin fiats", () => {
    expect(guessFiatFromSymbol("USDC")).toBe("USD");
    expect(guessFiatFromSymbol("XSGD")).toBe("SGD");
    expect(guessFiatFromSymbol("JPYC")).toBe("JPY");
    expect(guessFiatFromSymbol("EURC")).toBe("EUR");
  });

  it("defaults to USD for unknown", () => {
    expect(guessFiatFromSymbol("NEWCOIN")).toBe("USD");
  });

  it("is case-insensitive", () => {
    expect(guessFiatFromSymbol("xsgd")).toBe("SGD");
  });
});
