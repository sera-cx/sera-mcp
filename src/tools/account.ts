/**
 * Account / funds tools — thin wrappers around Sera's tx-builder + broadcast
 * endpoints. All are destructive (move money on-chain) and require API Key auth.
 *
 * Build/send pattern:
 *   1. Call `sera.build_approve` / `sera.build_deposit` / `sera.build_transfer`
 *      → returns unsigned EIP-1559 tx object.
 *   2. Sign the returned tx locally with the owner's wallet.
 *   3. Call `sera.send_tx` (approve/deposit) or `sera.send_transfer` (transfer)
 *      with `raw_tx` to broadcast.
 *
 * Withdraw is a 4-step dual-sig flow — see withdraw_request / withdraw_build /
 * withdraw_send below.
 */
import type { AppContext } from "../config.js";

export async function buildApprove(
  ctx: AppContext,
  args: { token: string; owner: string; spender: string; amount: string },
) {
  return ctx.sera.buildApprove(args);
}

export async function buildDeposit(
  ctx: AppContext,
  args: {
    token: string;
    owner: string;
    amount: string;
    permit_signature?: string;
    permit_deadline?: number;
    permit_amount?: string;
  },
) {
  // Permit pair validation: both or neither.
  if ((args.permit_signature && args.permit_deadline == null) ||
      (args.permit_deadline != null && !args.permit_signature)) {
    throw new Error(
      "permit_signature and permit_deadline must be provided together. " +
        "Omit both to use the standard depositFund flow.",
    );
  }
  return ctx.sera.buildDeposit(args);
}

export async function buildTransfer(
  ctx: AppContext,
  args: { token: string; to: string; amount: string; from_address: string },
) {
  return ctx.sera.buildTransfer(args);
}

export async function sendTx(ctx: AppContext, args: { raw_tx: string }) {
  return ctx.sera.sendTx(args.raw_tx);
}

export async function sendTransfer(ctx: AppContext, args: { raw_tx: string }) {
  return ctx.sera.sendTransfer(args.raw_tx);
}

// ─── Withdraw — 4-step dual-sig flow ────────────────────────────────────────

export interface WithdrawIntentArgs {
  user: string;
  tokens: string[];
  amounts: string[];
  recipient: string;
  deadline: string;
  uuid: string;
}

export async function withdrawRequest(
  ctx: AppContext,
  args: { intent: WithdrawIntentArgs; user_signature: string },
) {
  // Tokens vs amounts length must match (Sera will reject, but we surface a
  // clearer message at the MCP boundary).
  if (args.intent.tokens.length !== args.intent.amounts.length) {
    throw new Error(
      `tokens.length (${args.intent.tokens.length}) must equal amounts.length (${args.intent.amounts.length}).`,
    );
  }
  return ctx.sera.withdrawRequest({
    intent: args.intent,
    user_signature: args.user_signature,
  });
}

export async function withdrawBuild(
  ctx: AppContext,
  args: {
    intent: WithdrawIntentArgs;
    user_signature: string;
    executor: string;
    executor_signature: string;
  },
) {
  if (args.intent.tokens.length !== args.intent.amounts.length) {
    throw new Error(
      `tokens.length (${args.intent.tokens.length}) must equal amounts.length (${args.intent.amounts.length}).`,
    );
  }
  return ctx.sera.withdrawBuild(args);
}

export async function withdrawSend(ctx: AppContext, args: { raw_tx: string }) {
  return ctx.sera.withdrawSend(args.raw_tx);
}
