import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/config.js";
import { approvalStatus } from "../src/tools/account.js";
import { ApprovalStatusInput } from "../src/tools/schemas.js";

const token = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const vault = "0x3333333333333333333333333333333333333333";

function context(allowance: string, permitSupported = false): AppContext {
  return {
    sera: {
      getConfig: vi.fn().mockResolvedValue({ vault_address: vault }),
      getPermitMetadata: vi.fn().mockResolvedValue({
        current_allowance_raw: allowance,
        permit_supported: permitSupported,
      }),
    },
  } as unknown as AppContext;
}

describe("approvalStatus", () => {
  it("uses the live Vault address as spender and does not recommend approval when sufficient", async () => {
    const ctx = context("100", true);

    const result = await approvalStatus(ctx, { token, owner, amount: "100" });

    expect(ctx.sera.getPermitMetadata).toHaveBeenCalledWith({ token, owner, spender: vault, amount: "100" });
    expect(result).toMatchObject({
      token,
      owner,
      vault_address: vault,
      current_allowance_raw: "100",
      required_allowance_raw: "100",
      permit_supported: true,
      approval_required: false,
    });
    expect(result).not.toHaveProperty("next_step");
  });

  it("returns a complete Vault build_approve next step when allowance is short", async () => {
    const ctx = context("99");

    const result = await approvalStatus(ctx, { token, owner, amount: "100" });

    expect(result).toMatchObject({
      approval_required: true,
      next_step: {
        tool: "sera.build_approve",
        arguments: { token, owner, spender: vault, amount: "100" },
      },
    });
  });

  it("propagates config and permit metadata failures", async () => {
    const configFailure = context("0");
    vi.mocked(configFailure.sera.getConfig).mockRejectedValueOnce(new Error("config unavailable"));
    await expect(approvalStatus(configFailure, { token, owner, amount: "1" })).rejects.toThrow("config unavailable");

    const metadataFailure = context("0");
    vi.mocked(metadataFailure.sera.getPermitMetadata).mockRejectedValueOnce(new Error("metadata unavailable"));
    await expect(approvalStatus(metadataFailure, { token, owner, amount: "1" })).rejects.toThrow("metadata unavailable");
  });
});

describe("ApprovalStatusInput", () => {
  it.each([
    { token: "invalid", owner, amount: "1" },
    { token, owner: "invalid", amount: "1" },
    { token, owner, amount: "" },
    { token, owner, amount: "1.5" },
    { token, owner, amount: "-1" },
  ])("rejects invalid input %#", (input) => {
    expect(() => ApprovalStatusInput.parse(input)).toThrow();
  });
});
