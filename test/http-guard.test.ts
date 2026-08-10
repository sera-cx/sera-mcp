/**
 * http-guard.test.ts — public-bind startup guard logic.
 *
 * The guard is the code-level brake against accidentally exposing
 * Streamable HTTP without auth. Pure-function form is `publicBindGuardDecision`.
 */
import { describe, it, expect } from "vitest";
import { publicBindGuardDecision } from "../src/transports/http.js";

describe("publicBindGuardDecision — localhost binds always allowed", () => {
  it("127.0.0.1 with no allowedHosts and no ack → allow without ack", () => {
    const d = publicBindGuardDecision("127.0.0.1", undefined, undefined);
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.ack).toBe(false);
  });

  it("localhost variants are loopback", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const d = publicBindGuardDecision(host, undefined, undefined);
      expect(d.allow).toBe(true);
    }
  });

  it("normalizes harmless loopback spelling variants", () => {
    for (const host of [" LOCALHOST ", "[::1]", "0:0:0:0:0:0:0:1"]) {
      const d = publicBindGuardDecision(host, undefined, undefined);
      expect(d.allow).toBe(true);
      if (d.allow) expect(d.ack).toBe(false);
    }
  });

  it("localhost allowed even when ack accidentally set", () => {
    const d = publicBindGuardDecision("127.0.0.1", undefined, "true");
    expect(d.allow).toBe(true);
  });
});

describe("publicBindGuardDecision — non-loopback requires allowedHosts or ack", () => {
  it("0.0.0.0 with neither → refuse with reason", () => {
    const d = publicBindGuardDecision("0.0.0.0", undefined, undefined);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toMatch(/no built-in auth/);
      expect(d.reason).toMatch(/SERA_HTTP_ALLOW_UNAUTHENTICATED_PUBLIC/);
    }
  });

  it("0.0.0.0 with allowedHosts → allow (auth assumed at reverse proxy)", () => {
    const d = publicBindGuardDecision("0.0.0.0", ["my.domain"], undefined);
    expect(d.allow).toBe(true);
  });

  it("0.0.0.0 with empty allowedHosts → refuse (empty array doesn't count)", () => {
    const d = publicBindGuardDecision("0.0.0.0", [], undefined);
    expect(d.allow).toBe(false);
  });

  it("0.0.0.0 with explicit ack → allow with ack flag", () => {
    const d = publicBindGuardDecision("0.0.0.0", undefined, "true");
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.ack).toBe(true);
  });

  it("0.0.0.0 with ack=false → refuse", () => {
    const d = publicBindGuardDecision("0.0.0.0", undefined, "false");
    expect(d.allow).toBe(false);
  });

  it("0.0.0.0 with ack=TRUE (uppercase) → allow", () => {
    const d = publicBindGuardDecision("0.0.0.0", undefined, "TRUE");
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.ack).toBe(true);
  });

  it("public IP bind requires same treatment as 0.0.0.0", () => {
    const d = publicBindGuardDecision("203.0.113.42", undefined, undefined);
    expect(d.allow).toBe(false);
  });

  it("allowedHosts takes precedence over missing ack", () => {
    const d = publicBindGuardDecision("203.0.113.42", ["api.example.com"], undefined);
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.ack).toBe(false);
  });
});
