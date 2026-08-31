/**
 * registry.test.ts — meta-tests over the tool registry.
 *
 * Locks in invariants every new tool must satisfy:
 *   - Unique name.
 *   - Has a category in the supported set.
 *   - Has annotations (at minimum a title).
 *   - destructive tools are flagged destructive: true.
 *   - readOnly tools are flagged readOnly: true and never destructive: true.
 *   - outputSchema-bearing tools have a Zod schema (not undefined).
 *
 * These tests are the "no future tool can skip metadata" guard.
 */
import { describe, it, expect } from "vitest";
import { TOOLS, TOOLS_BY_CATEGORY, type ToolCategory } from "../src/tools/registry.js";

const ALLOWED_CATEGORIES: ToolCategory[] = [
  "discovery",
  "pricing",
  "liquidity",
  "quote_planning",
  "treasury",
  "history",
  "execution",
  "account",
  "withdraw",
  "debugging",
  "maker",
];

const KNOWN_DESTRUCTIVE = new Set([
  "sera.execute_swap",
  "sera.convert_and_send",
  "sera.send_tx",
  "sera.send_transfer",
  "sera.withdraw_send",
  "sera.place_order",
  "sera.cancel_order",
  "sera.cancel_all_orders",
  "sera.place_vl_batch",
  "sera.cancel_vl_batch",
]);

describe("TOOLS registry — basic invariants", () => {
  it("has at least 56 tools (current is 56)", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(56);
  });

  it("every tool name is unique", () => {
    const names = TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("every tool name uses sera.* prefix", () => {
    for (const t of TOOLS) {
      expect(t.name.startsWith("sera.")).toBe(true);
    }
  });

  it("every tool has a non-empty description", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("every tool has a title in annotations", () => {
    for (const t of TOOLS) {
      expect(t.annotations.title).toBeDefined();
      expect(t.annotations.title!.length).toBeGreaterThan(0);
    }
  });

  it("every tool has an inputSchema (Zod)", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema).toBeDefined();
      // ZodTypeAny shape duck-check
      expect(typeof (t.inputSchema as any).parse).toBe("function");
    }
  });

  it("every tool's category is in the allowed set", () => {
    for (const t of TOOLS) {
      expect(ALLOWED_CATEGORIES).toContain(t.category);
    }
  });

  it("every tool has a callable handler", () => {
    for (const t of TOOLS) {
      expect(typeof t.handler).toBe("function");
    }
  });
});

describe("TOOLS registry — annotation correctness", () => {
  it("registers approval_status as a read-only account tool", () => {
    const tool = TOOLS.find((t) => t.name === "sera.approval_status");
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("account");
    expect(tool?.annotations.readOnly).toBe(true);
    expect(tool?.annotations.destructive).toBeFalsy();
  });

  it("known destructive tools are flagged destructive: true", () => {
    for (const t of TOOLS) {
      if (KNOWN_DESTRUCTIVE.has(t.name)) {
        expect(t.annotations.destructive, `${t.name} should be destructive:true`).toBe(true);
      }
    }
  });

  it("readOnly tools are never destructive", () => {
    for (const t of TOOLS) {
      if (t.annotations.readOnly === true) {
        expect(t.annotations.destructive, `${t.name} cannot be both readOnly and destructive`).toBeFalsy();
      }
    }
  });

  it("destructive tools are never marked readOnly", () => {
    for (const t of TOOLS) {
      if (t.annotations.destructive === true) {
        expect(t.annotations.readOnly, `${t.name} cannot be both destructive and readOnly`).toBeFalsy();
      }
    }
  });

  it("execution-category tools are all destructive (or are execute_swap allowance)", () => {
    const exec = TOOLS_BY_CATEGORY.execution ?? [];
    expect(exec.length).toBeGreaterThan(0);
    for (const t of exec) {
      expect(t.annotations.destructive, `${t.name} in 'execution' category must be destructive`).toBe(true);
    }
  });

  it("maker-category tools are all destructive (orders move state)", () => {
    const makers = TOOLS_BY_CATEGORY.maker ?? [];
    expect(makers.length).toBeGreaterThan(0);
    for (const t of makers) {
      if (t.name.startsWith("sera.get_") || t.name.startsWith("sera.list_")) {
        // read tools are exception
        continue;
      }
      expect(
        t.annotations.destructive,
        `${t.name} (maker write) must be destructive`,
      ).toBe(true);
    }
  });
});

describe("TOOLS_BY_CATEGORY — grouping", () => {
  it("every tool appears in exactly one category group", () => {
    let total = 0;
    for (const cat of ALLOWED_CATEGORIES) {
      total += (TOOLS_BY_CATEGORY[cat] ?? []).length;
    }
    expect(total).toBe(TOOLS.length);
  });

  it("contains the documented core categories", () => {
    for (const cat of ["discovery", "pricing", "execution", "maker", "account", "withdraw"] as ToolCategory[]) {
      expect((TOOLS_BY_CATEGORY[cat] ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe("TOOLS registry — outputSchema correctness", () => {
  it("outputSchema tools have a parseable Zod schema", () => {
    const withOutput = TOOLS.filter((t) => t.outputSchema);
    expect(withOutput.length).toBeGreaterThan(0);
    for (const t of withOutput) {
      expect(typeof (t.outputSchema as any).parse).toBe("function");
    }
  });

  it("the 4 v0.7.0 outputSchema-migrated tools are still tagged", () => {
    const expected = ["sera.doctor", "sera.list_currencies", "sera.get_fx_rate", "sera.market_health"];
    for (const name of expected) {
      const t = TOOLS.find((x) => x.name === name);
      expect(t?.outputSchema, `${name} should have outputSchema`).toBeDefined();
    }
  });
});
