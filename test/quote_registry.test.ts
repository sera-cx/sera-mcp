import { describe, it, expect } from "vitest";
import {
  registerQuote,
  lookupQuote,
  routeParamsMatch,
  registrySize,
} from "../src/util/quote_registry.js";

const SAMPLE_ROUTE = {
  taker: "0x" + "a".repeat(40),
  inputToken: "0x" + "1".repeat(40),
  outputToken: "0x" + "2".repeat(40),
  maxInputAmount: "1000000",
  minOutputAmount: "923450",
  recipient: "0x" + "a".repeat(40),
  initialDepositAmount: "1000000",
  uuid: "12345",
  deadline: 9999999999,
};

describe("quote registry", () => {
  it("registers and looks up a quote", () => {
    const uuid = "uuid-1-" + Date.now();
    registerQuote(uuid, SAMPLE_ROUTE, Math.floor(Date.now() / 1000) + 600);
    const hit = lookupQuote(uuid);
    expect(hit).toBeDefined();
    expect(hit?.route_params.uuid).toBe("12345");
  });

  it("returns undefined for unknown uuid", () => {
    expect(lookupQuote("nonexistent-uuid")).toBeUndefined();
  });

  it("auto-evicts expired entries on lookup", () => {
    const uuid = "uuid-expired-" + Date.now();
    // expires_at in the past
    registerQuote(uuid, SAMPLE_ROUTE, Math.floor(Date.now() / 1000) - 10);
    expect(lookupQuote(uuid)).toBeUndefined();
  });

  it("preserves estimated_usd_notional", () => {
    const uuid = "uuid-notional-" + Date.now();
    registerQuote(uuid, SAMPLE_ROUTE, Math.floor(Date.now() / 1000) + 600, 5000);
    expect(lookupQuote(uuid)?.estimated_usd_notional).toBe(5000);
  });
});

describe("routeParamsMatch", () => {
  it("returns ok:true for byte-identical params", () => {
    expect(routeParamsMatch(SAMPLE_ROUTE, { ...SAMPLE_ROUTE })).toEqual({ ok: true });
  });

  it("ignores fields not in signed-fields whitelist", () => {
    const candidate = { ...SAMPLE_ROUTE, opaque_extra: "vendor-metadata" };
    expect(routeParamsMatch(SAMPLE_ROUTE, candidate)).toEqual({ ok: true });
  });

  it("catches a minOutputAmount mismatch (the canonical attack)", () => {
    const tampered = { ...SAMPLE_ROUTE, minOutputAmount: "1" };
    const m = routeParamsMatch(SAMPLE_ROUTE, tampered);
    expect(m.ok).toBe(false);
    if (!m.ok) {
      expect(m.field).toBe("minOutputAmount");
      expect(m.registered).toBe("923450");
      expect(m.candidate).toBe("1");
    }
  });

  it("catches a recipient swap (re-routing attack)", () => {
    const tampered = { ...SAMPLE_ROUTE, recipient: "0x" + "f".repeat(40) };
    expect(routeParamsMatch(SAMPLE_ROUTE, tampered).ok).toBe(false);
  });

  it("catches a uuid mismatch", () => {
    const tampered = { ...SAMPLE_ROUTE, uuid: "99999" };
    expect(routeParamsMatch(SAMPLE_ROUTE, tampered).ok).toBe(false);
  });

  it("string-coerces for comparison (so numeric vs string uuid works)", () => {
    const candidate = { ...SAMPLE_ROUTE, uuid: 12345 as any };
    expect(routeParamsMatch(SAMPLE_ROUTE, candidate).ok).toBe(true);
  });

  it("treats missing field as not-equal", () => {
    const { recipient, ...partial } = SAMPLE_ROUTE;
    const m = routeParamsMatch(SAMPLE_ROUTE, partial as any);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.field).toBe("recipient");
  });
});

describe("registrySize", () => {
  it("returns a non-negative integer", () => {
    const n = registrySize();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
