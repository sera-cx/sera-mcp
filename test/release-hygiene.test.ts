/**
 * release-hygiene.test.ts — guards against the packaging mistakes this repo
 * has actually made before.
 *
 * The version string lives in four places (package.json, the MCP handshake
 * constant, and two fields in server.json for the MCP Registry). v0.8.1 shipped
 * with SERVER_VERSION still advertising 0.8.2 — see CHANGELOG. Hosts read the
 * handshake version to reason about capabilities, and the registry reads
 * server.json, so drift misreports the server to every client.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SERVER_VERSION } from "../src/server/create-server.js";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const pkg = read("../package.json");
const serverJson = read("../server.json");

describe("version stays in sync across every declaration", () => {
  it("MCP handshake version matches package.json", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("server.json (MCP Registry) matches package.json", () => {
    expect(serverJson.version).toBe(pkg.version);
    // Registry entries carry a nested package version too; both must agree or
    // the published listing points at a different release than it claims.
    for (const p of serverJson.packages ?? []) {
      expect(p.version, `server.json packages[].version for ${p.identifier ?? "?"}`).toBe(pkg.version);
    }
  });
});

describe("publish surface", () => {
  it("build output is cleaned before publish so deleted source can't ship", () => {
    // `files: ["dist"]` means whatever sits in dist/ at publish time is what
    // ships. `build` is a bare tsc, which never removes stale artifacts, so a
    // publish from a warm working copy can carry files whose source is gone.
    expect(pkg.scripts.clean, "expected a `clean` script").toBeTruthy();
    expect(pkg.scripts.prepublishOnly, "expected a `prepublishOnly` script").toBeTruthy();
    expect(pkg.scripts.prepublishOnly).toContain("clean");
  });

  it("declares the files allowlist rather than publishing the whole tree", () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("dist");
    expect(pkg.files).not.toContain("src");
  });
});
