/**
 * signer-secret-safety.test.ts — the private key must never reach a log.
 *
 * src/index.ts's fatal handler does `log.error("fatal", { error: err?.stack })`,
 * so ANY error thrown while constructing the signer is serialized to stderr in
 * full. ethers only redacts a key that parses as 32 bytes of hex; for anything
 * else it throws `invalid BytesLike value (... value="<the raw key>" ...)`.
 *
 * A secret file or `docker secret` mount normally ends in a newline, so this
 * was reachable through ordinary deployment, not a contrived input.
 */
import { describe, it, expect } from "vitest";
import { createSigner } from "../src/signer/signer.js";

// Structurally valid key material used only to assert it never gets echoed.
const SECRET = "ab".repeat(32);

const MALFORMED: Array<[string, string]> = [
  ["trailing newline", `0x${SECRET}\n`],
  ["leading/trailing space", `  0x${SECRET}  `],
  ["no 0x prefix", SECRET],
  ["truncated", `0x${"ab".repeat(20)}`],
  ["non-hex garbage", `0x${"zz".repeat(32)}`],
  ["empty", ""],
];

describe("LocalSigner never leaks key material into errors", () => {
  for (const [label, key] of MALFORMED) {
    it(`does not echo the key for: ${label}`, () => {
      let thrown: unknown;
      try {
        createSigner("local", key);
      } catch (e) {
        thrown = e;
      }

      // Whitespace-padded and prefix-less forms are legitimate secret-file
      // contents and must be ACCEPTED, not just safely rejected.
      if (["trailing newline", "leading/trailing space", "no 0x prefix"].includes(label)) {
        expect(thrown, `${label} should be accepted after trimming`).toBeUndefined();
        return;
      }

      expect(thrown, `${label} should be rejected`).toBeInstanceOf(Error);
      const err = thrown as Error;
      const serialized = `${err.message}\n${err.stack ?? ""}`;
      // The exact bytes the fatal handler would write to stderr.
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("ab".repeat(16));
      // An empty value is caught by createSigner's own required-arg guard,
      // which has no key to withhold; every other rejection comes from
      // LocalSigner and must say so explicitly.
      if (label !== "empty") expect(serialized).toContain("withheld");
    });
  }

  it("accepts a well-formed key and derives a stable address", async () => {
    const a = await createSigner("local", `0x${SECRET}`).address();
    // Same key, whitespace-padded and prefix-less, must resolve identically.
    const b = await createSigner("local", `  ${SECRET}\n`).address();
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b).toBe(a);
  });
});
