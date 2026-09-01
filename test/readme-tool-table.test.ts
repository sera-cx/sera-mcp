/**
 * readme-tool-table.test.ts — the README's category table must match the registry.
 *
 * PR #4 added `sera.approval_status` and bumped the README's headline count to
 * 56, but never added the tool to the category table — which therefore listed
 * 55. CI was green throughout, because nothing compared the two.
 *
 * Branch protection cannot catch this class of bug: required status checks only
 * enforce what CI actually tests. This is that test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOOLS } from "../src/tools/registry.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/**
 * Pull the tool names out of the "| Category | Tools |" table specifically.
 * The README has several other backtick-bearing tables (env vars, policy
 * presets, the feature matrix), so anchor on the header and stop at the first
 * line that is no longer a table row.
 */
function parseCategoryTable(): { names: string[]; rowCount: number } {
  const lines = README.split("\n");
  const start = lines.findIndex((l) => l.trim() === "| Category | Tools |");
  if (start === -1) throw new Error("category table header not found in README.md");

  const names: string[] = [];
  let rowCount = 0;
  // +2 skips the header and the |---|---| separator.
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    rowCount++;
    for (const m of line.matchAll(/`([A-Za-z0-9_]+)`/g)) names.push(m[1]);
  }
  return { names, rowCount };
}

// Registry names are prefixed (`sera.get_markets`); the table lists them bare.
const registryNames = TOOLS.map((t) => t.name.replace(/^sera\./, ""));

describe("README category table tracks the tool registry", () => {
  const { names: tableNames, rowCount } = parseCategoryTable();

  it("lists every registered tool", () => {
    const missing = registryNames.filter((n) => !tableNames.includes(n));
    expect(
      missing,
      `these tools are registered but absent from the README category table: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lists no tool that is not registered", () => {
    const extra = tableNames.filter((n) => !registryNames.includes(n));
    expect(
      extra,
      `these names appear in the README category table but are not registered: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("has no duplicate entries", () => {
    const seen = new Set<string>();
    const dupes = tableNames.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes, `duplicated in the README table: ${dupes.join(", ")}`).toEqual([]);
  });

  it("sums to the registry size, and the headline count agrees", () => {
    expect(tableNames.length).toBe(TOOLS.length);

    // The prose count above the table ("**58 tools across 11 categories**")
    // is a third place the number is written down; keep it honest too.
    const headline = README.match(/\*\*(\d+) tools across (\d+) categories\*\*/);
    expect(headline, "headline '**N tools across M categories**' not found").not.toBeNull();
    expect(Number(headline![1]), "headline tool count").toBe(TOOLS.length);
    expect(Number(headline![2]), "headline category count").toBe(rowCount);
  });
});
