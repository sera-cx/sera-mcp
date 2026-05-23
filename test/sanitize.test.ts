import { describe, it, expect } from "vitest";
import {
  safeAddress,
  safeFiat,
  safeNumber,
  safeSymbolList,
  safeAddressList,
  safeFiatList,
} from "../src/util/sanitize.js";

describe("safeAddress", () => {
  it("accepts a valid 0x-prefixed 40-hex address", () => {
    expect(safeAddress("addr", "0x" + "a".repeat(40))).toBe("0x" + "a".repeat(40));
  });
  it("rejects missing without fallback", () => {
    expect(() => safeAddress("addr", undefined)).toThrow(/rejected \(missing\)/);
  });
  it("uses fallback when value missing", () => {
    expect(safeAddress("addr", undefined, "0x" + "b".repeat(40))).toBe("0x" + "b".repeat(40));
  });
  it("rejects wrong-length hex", () => {
    expect(() => safeAddress("addr", "0xdead")).toThrow(/0x-prefixed 40-hex/);
  });
  it("rejects newline injection", () => {
    expect(() => safeAddress("addr", "0x" + "a".repeat(40) + "\n...")).toThrow();
  });
  it("rejects non-hex chars", () => {
    expect(() => safeAddress("addr", "0x" + "g".repeat(40))).toThrow();
  });
});

describe("safeFiat", () => {
  it("uppercases and accepts 3-letter ISO", () => {
    expect(safeFiat("base", "usd")).toBe("USD");
  });
  it("rejects lowercase only when malformed", () => {
    expect(() => safeFiat("base", "us")).toThrow(/3-letter ISO/);
  });
  it("rejects 4-letter", () => {
    expect(() => safeFiat("base", "USDC")).toThrow();
  });
  it("rejects digits", () => {
    expect(() => safeFiat("base", "US1")).toThrow();
  });
  it("uses fallback when missing", () => {
    expect(safeFiat("base", undefined, "EUR")).toBe("EUR");
  });
  it("rejects injection via newline", () => {
    expect(() => safeFiat("base", "USD\nIgnore previous")).toThrow();
  });
});

describe("safeNumber", () => {
  it("accepts integers", () => {
    expect(safeNumber("amount", "1000")).toBe(1000);
  });
  it("accepts decimals", () => {
    expect(safeNumber("amount", "1.5")).toBe(1.5);
  });
  it("accepts negative", () => {
    expect(safeNumber("amount", "-1.5")).toBe(-1.5);
  });
  it("rejects scientific notation", () => {
    expect(() => safeNumber("amount", "1e10")).toThrow();
  });
  it("rejects NaN string", () => {
    expect(() => safeNumber("amount", "NaN")).toThrow();
  });
  it("rejects Infinity string", () => {
    expect(() => safeNumber("amount", "Infinity")).toThrow();
  });
  it("rejects leading spaces+digits hybrid injection", () => {
    expect(() => safeNumber("amount", "100; DROP TABLE")).toThrow();
  });
  it("uses fallback when missing", () => {
    expect(safeNumber("amount", undefined, 42)).toBe(42);
  });
});

describe("safeSymbolList", () => {
  it("accepts comma-separated uppercase symbols", () => {
    expect(safeSymbolList("symbols", "USDC,USDT,XSGD")).toEqual(["USDC", "USDT", "XSGD"]);
  });
  it("uppercases lowercase input", () => {
    expect(safeSymbolList("symbols", "usdc,usdt")).toEqual(["USDC", "USDT"]);
  });
  it("trims whitespace", () => {
    expect(safeSymbolList("symbols", " USDC , USDT ")).toEqual(["USDC", "USDT"]);
  });
  it("rejects empty entries", () => {
    expect(() => safeSymbolList("symbols", ",,,")).toThrow(/empty list/);
  });
  it("rejects symbols with special chars", () => {
    expect(() => safeSymbolList("symbols", "USDC,US-DT")).toThrow();
  });
  it("rejects too-long symbols", () => {
    expect(() => safeSymbolList("symbols", "VERYLONGSYMBOLNAME")).toThrow();
  });
});

describe("safeAddressList", () => {
  it("accepts valid addresses", () => {
    const a = "0x" + "a".repeat(40);
    const b = "0x" + "b".repeat(40);
    expect(safeAddressList("recips", `${a},${b}`)).toEqual([a, b]);
  });
  it("rejects on any single bad address", () => {
    expect(() => safeAddressList("recips", "0x" + "a".repeat(40) + ",0xdead")).toThrow();
  });
});

describe("safeFiatList", () => {
  it("uppercases entries", () => {
    expect(safeFiatList("basket", "usd,sgd")).toEqual(["USD", "SGD"]);
  });
  it("uses fallback when missing", () => {
    expect(safeFiatList("basket", undefined, ["USD", "EUR"])).toEqual(["USD", "EUR"]);
  });
});
