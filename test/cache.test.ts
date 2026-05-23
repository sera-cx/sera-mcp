import { describe, it, expect } from "vitest";
import { TtlCache } from "../src/util/cache.js";

describe("TtlCache", () => {
  it("caches a value across calls within TTL", async () => {
    const cache = new TtlCache<{ n: number }>(1000);
    let calls = 0;
    const factory = async () => ({ n: ++calls });
    const r1 = await cache.get("k", factory);
    const r2 = await cache.get("k", factory);
    expect(r1).toEqual({ n: 1 });
    expect(r2).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it("expires after TTL elapses", async () => {
    const cache = new TtlCache<{ n: number }>(20);
    let calls = 0;
    const factory = async () => ({ n: ++calls });
    await cache.get("k", factory);
    await new Promise((r) => setTimeout(r, 30));
    await cache.get("k", factory);
    expect(calls).toBe(2);
  });

  it("dedupes concurrent in-flight requests for the same key", async () => {
    const cache = new TtlCache<{ n: number }>(1000);
    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { n: calls };
    };
    const [a, b, c] = await Promise.all([
      cache.get("k", factory),
      cache.get("k", factory),
      cache.get("k", factory),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("does not cache thrown errors", async () => {
    const cache = new TtlCache<{ n: number }>(1000);
    let calls = 0;
    const factory = async () => {
      calls++;
      if (calls === 1) throw new Error("first call fails");
      return { n: calls };
    };
    await expect(cache.get("k", factory)).rejects.toThrow();
    // second call should retry, not return cached error
    const r = await cache.get("k", factory);
    expect(r).toEqual({ n: 2 });
  });

  it("keys are independent", async () => {
    const cache = new TtlCache<{ key: string }>(1000);
    const a = await cache.get("a", async () => ({ key: "a" }));
    const b = await cache.get("b", async () => ({ key: "b" }));
    expect(a.key).toBe("a");
    expect(b.key).toBe("b");
  });
});
