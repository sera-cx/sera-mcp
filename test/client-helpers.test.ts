import { describe, it, expect } from "vitest";
import { parseRetryAfter, lowerOwner } from "../src/sera/client.js";

describe("parseRetryAfter", () => {
  it("returns fallback when header missing", () => {
    expect(parseRetryAfter(undefined)).toBe(1000);
  });

  it("parses integer seconds and converts to ms", () => {
    expect(parseRetryAfter("3")).toBe(3000);
  });

  it("caps at 5s (RETRY_AFTER_CAP_MS) when upstream lies", () => {
    expect(parseRetryAfter("9999")).toBe(5000);
  });

  it("accepts 0 (immediate retry allowed by spec)", () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("rejects negative and falls back", () => {
    expect(parseRetryAfter("-5")).toBe(1000);
  });

  it("rejects non-numeric garbage and falls back", () => {
    expect(parseRetryAfter("not a number")).toBe(1000);
  });

  it("handles HTTP-date format (future date)", () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("falls back on past HTTP-date", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(1000);
  });

  it("handles array-form header (some clients pass headers as arrays)", () => {
    expect(parseRetryAfter(["2"])).toBe(2000);
  });
});

describe("lowerOwner", () => {
  it("lowercases EIP-55 checksum address for read endpoints", () => {
    expect(lowerOwner("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("is idempotent on already-lowercase", () => {
    const addr = "0xabcdef0123456789abcdef0123456789abcdef01";
    expect(lowerOwner(addr)).toBe(addr);
  });
});
