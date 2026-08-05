/**
 * Maker / order-book tools — wrap Sera's /orders endpoints.
 *
 * Order placement, cancellation, and listing. All write operations require
 * the agent to sign Order / CancelOrder / CancelVLBatch structs as EIP-712
 * typed data under the Sera domain — see [sera-cx/sera-mcp]
 * ARCHITECTURE.md or docs.sera.cx/contracts/sera/ for struct shapes.
 *
 * This file does NOT construct uuid_int values nor sign Orders on the server.
 * The agent (or a wallet library on the caller side) constructs the composite
 * uuid_int from a UUID4 + executor_id (read once at startup, see sera.doctor)
 * and signs the struct.
 *
 * For local-signer server-side order signing, see sera.execute_swap pattern
 * — a future release may add an analogous server-side flow for makers.
 */
import type { AppContext } from "../config.js";
import type {
  CancelOrderRequest,
  CancelVlBatchRequest,
  PlaceOrderRequest,
  PlaceVlBatchRequest,
} from "../sera/types.js";

export async function placeOrder(ctx: AppContext, args: PlaceOrderRequest) {
  return ctx.sera.postOrder(args);
}

export async function cancelOrder(ctx: AppContext, args: CancelOrderRequest) {
  return ctx.sera.cancelOrder(args);
}

export async function cancelAllOrders(ctx: AppContext, args: { owner_address: string }) {
  return ctx.sera.cancelAllOrders(args.owner_address);
}

export async function placeVlBatch(ctx: AppContext, args: PlaceVlBatchRequest) {
  // Surface VL preflight errors at the boundary for clarity (Sera will reject
  // these too, but with less context).
  if (args.orders.length < 2 || args.orders.length > 50) {
    throw new Error(`VL batch size ${args.orders.length} outside [2, 50]. Read live cap from sera://config → limits.vl_batch.max.`);
  }
  const firstOwner = args.orders[0].owner_address.toLowerCase();
  for (const o of args.orders) {
    if (o.owner_address.toLowerCase() !== firstOwner) {
      throw new Error(`VL batch siblings must share owner_address. Found ${o.owner_address} vs ${firstOwner}.`);
    }
  }
  return ctx.sera.postVlBatch(args);
}

export async function cancelVlBatch(ctx: AppContext, args: CancelVlBatchRequest) {
  return ctx.sera.cancelVlBatch(args);
}

export async function getOrder(ctx: AppContext, args: { order_id: string }) {
  return ctx.sera.getOrder(args.order_id);
}

export async function listOrders(ctx: AppContext, args: Record<string, any>) {
  // Pass through to Sera's rich filter surface. Booleans serialized as strings.
  const filters: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") filters[k] = v ? "true" : "false";
    else filters[k] = v as string | number;
  }
  return ctx.sera.getOrders(filters);
}

export async function getFillsForOrder(
  ctx: AppContext,
  args: { order_id: string; limit?: number; offset?: number },
) {
  const { order_id, ...rest } = args;
  return ctx.sera.getFillsForOrder(order_id, rest);
}

export async function listFills(ctx: AppContext, args: Record<string, any>) {
  const filters: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    filters[k] = v as string | number;
  }
  return ctx.sera.getFills(filters);
}
