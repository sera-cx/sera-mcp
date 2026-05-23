/**
 * Helper / debugging tools — batch quote, signature verifier, permit metadata.
 *
 * batch_quote replaces client-side fan-out with Sera's single endpoint (up to
 * 50 quotes per call). Useful for makers pricing many pairs at once.
 *
 * verify_signature lets callers test EIP-712 signatures before placing orders
 * — saves a wasted quote burn when signature plumbing is wrong.
 *
 * permit_metadata gates the approve-vs-permit decision: token doesn't support
 * EIP-2612 → fall back to POST /approve.
 */
import type { AppContext } from "../config.js";
import type { SwapQuoteRequest } from "../sera/types.js";
import { resolveToken, toRawAmount } from "../sera/tokens.js";

const SIMULATE_OWNER = "0x000000000000000000000000000000000000dEaD";

interface BatchQuoteArgs {
  quotes: Array<{
    from: string;
    to: string;
    amount: string | number;
    owner_address?: string;
    recipient?: string;
    gas_mode: "receive_less" | "pay_more";
    expiration_seconds?: number;
    simulate?: boolean;
  }>;
}

export async function batchQuote(ctx: AppContext, args: BatchQuoteArgs) {
  // Anchor expiration to server clock to avoid skew rejection.
  let now: number;
  try {
    const t = await ctx.sera.getSystemTime();
    now = Number(t.timestamp);
  } catch {
    now = Math.floor(Date.now() / 1000);
  }

  // Resolve all items in parallel. Each item carries its own policy gate;
  // any rejected item surfaces as an in-place error rather than failing the
  // whole batch (mirrors Sera's per-item error envelope).
  const requests: Array<{ ok: true; req: SwapQuoteRequest } | { ok: false; reason: string }> =
    await Promise.all(
      args.quotes.map(async (q) => {
        try {
          const fromTok = await resolveToken(ctx.sera, q.from);
          const toTok = await resolveToken(ctx.sera, q.to);
          const sym1 = ctx.policy.checkSymbol(fromTok);
          if (!sym1.ok) return { ok: false as const, reason: `policy: ${sym1.reason}` };
          const sym2 = ctx.policy.checkSymbol(toTok);
          if (!sym2.ok) return { ok: false as const, reason: `policy: ${sym2.reason}` };
          const ownerAddress = q.simulate
            ? SIMULATE_OWNER
            : (q.owner_address ?? SIMULATE_OWNER);
          if (!q.simulate && !q.owner_address) {
            return { ok: false as const, reason: "owner_address required for non-simulated quote" };
          }
          const recipient = q.recipient ?? ownerAddress;
          const rec = ctx.policy.checkRecipient(recipient);
          if (!rec.ok) return { ok: false as const, reason: `policy: ${rec.reason}` };
          const ttl = Math.min(
            Math.max(30, q.expiration_seconds ?? ctx.policy.config.defaultExpirationSeconds),
            ctx.policy.config.maxExpirationSeconds,
          );
          return {
            ok: true as const,
            req: {
              from_token: fromTok.address,
              to_token: toTok.address,
              from_amount: toRawAmount(q.amount, fromTok.decimals),
              owner_address: ownerAddress,
              recipient,
              expiration: now + ttl,
              gas_mode: q.gas_mode,
            },
          };
        } catch (err: any) {
          return { ok: false as const, reason: err?.message ?? String(err) };
        }
      }),
    );

  // Send only the items that passed policy. Track original index so we can
  // reassemble in input order with errors interleaved.
  const okIndices: number[] = [];
  const sendBatch: SwapQuoteRequest[] = [];
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    if (r.ok) {
      okIndices.push(i);
      sendBatch.push(r.req);
    }
  }

  let batchResult: Awaited<ReturnType<typeof ctx.sera.postSwapQuoteBatch>> | undefined;
  if (sendBatch.length > 0) {
    batchResult = await ctx.sera.postSwapQuoteBatch(sendBatch);
  }

  // Reassemble in input order.
  const items = requests.map((r, idx) => {
    if (!r.ok) {
      return {
        ok: false,
        quote: null,
        error: { rejectionCategory: "policy", message: r.reason },
      };
    }
    const batchIdx = okIndices.indexOf(idx);
    return batchResult!.items[batchIdx];
  });

  return { items };
}

export async function verifySignature(
  ctx: AppContext,
  args: Record<string, unknown>,
) {
  return ctx.sera.verifySignature(args);
}

export async function permitMetadata(
  ctx: AppContext,
  args: { token: string; owner: string; spender: string; amount?: string },
) {
  return ctx.sera.getPermitMetadata(args);
}
