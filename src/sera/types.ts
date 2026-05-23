// Types mirror Sera's public REST API documented at docs.sera.cx.
// Keep these conservative — Sera evolves quickly; treat unknown fields as opaque.

export interface SeraToken {
  symbol: string;
  address: string;
  decimals: number;
  fiat_currency?: string; // e.g. "USD", "SGD", "MYR" — when Sera tags it
  name?: string;
}

export interface SeraMarket {
  base_token: string;       // address
  quote_token: string;      // address
  base_symbol: string;
  quote_symbol: string;
  display_pair: string;     // e.g. "XSGD/USDC"
}

export type GasMode = "receive_less" | "pay_more";

export interface SwapQuoteRequest {
  from_token: string;
  to_token: string;
  from_amount: string;       // raw token units
  owner_address: string;
  recipient: string;
  expiration: number;        // unix seconds
  gas_mode: GasMode;
}

// EIP-712 Intent struct (Sera SOR).
// Signed under: domain { name: "Sera", version: "1", chainId, verifyingContract: sera_address }
export interface SeraIntent {
  taker: string;
  inputToken: string;
  outputToken: string;
  maxInputAmount: string;    // uint256 as decimal string
  minOutputAmount: string;
  recipient: string;
  initialDepositAmount: string;
  uuid: string;              // uint256 as decimal string
  deadline: number;          // uint48
}

// EIP-2612 Permit envelope returned by /swap/quote when the swap is wallet-funded
// (initialDepositAmount > 0) and the input token supports permit. POST /swap REQUIRES
// permit_signature + permit_deadline in this case. If `permit` is null, the token doesn't
// support permit (fall back to POST /approve) OR the swap is vault-funded (no permit needed).
export interface PermitEnvelope {
  permit_supported: boolean;
  permit_required: boolean;
  token: string;
  spender: string;
  owner: string;
  value_raw: string;
  current_allowance_raw: string;
  nonce: number;
  suggested_deadline: number;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  eip712: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    primaryType: "Permit";
    types: { Permit: Array<{ name: string; type: string }> };
    message: {
      owner: string;
      spender: string;
      value: string;
      nonce: number;
      deadline: number;
    };
  };
}

export interface SwapQuoteResponse {
  uuid: string;
  route_params: SeraIntent;
  fee_breakdown?: {
    gas_cost_usd?: string;
    gas_cost_from_token?: string;
  };
  expires_at: number;
  permit?: PermitEnvelope | null;
  // Sera may include richer route preview / price info; pass through opaque.
  [k: string]: unknown;
}

export interface SwapExecuteRequest {
  uuid: string;
  signature: string;
  // Required when the originating /swap/quote response carried a non-null `permit`
  // envelope (wallet-funded swap on EIP-2612-supported token). Sera's POST /swap
  // rejects the request without these when the quote was issued with permit.
  permit_signature?: string;
  permit_deadline?: number;
}

export interface SwapExecuteResponse {
  success: boolean;
  trade_id?: string;
  [k: string]: unknown;
}

export interface BalanceRow {
  symbol: string;
  address: string;
  decimals: number;
  wallet_balance: string;     // raw uint256
  vault_available: string;
  vault_frozen: string;
}

export interface BalancesResponse {
  balances: BalanceRow[];
}

export interface FxRateResponse {
  base: string;
  quote: string;
  rate: string;
  change_24h?: string;
  source?: string;
}

export interface SeraConfig {
  chain_id: number;
  sera_address: string;
  vault_address: string;
  sor_address: string;
  domain_separator?: string;
  eip712_domain?: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  limits?: {
    vl_batch?: { min: number; max: number };
  };
  [k: string]: unknown;
}

// Unsigned EIP-1559 transaction shape returned by /approve, /deposit,
// /withdraw/build, /transfer.
export interface UnsignedTx {
  to: string;
  data: string;
  value: string;
  chainId: string;
  nonce: string;
  gas: string;
  type: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface BuildTxResponse {
  tx: UnsignedTx;
}

export interface TxSendResponse {
  tx_hash: string;
}

// Withdraw step 1 response (executor co-signature).
export interface WithdrawCosignResponse {
  success: boolean;
  executor_address: string;
  executor_signature: string;
  error: string | null;
}

// Verify-signature endpoint shape.
export interface VerifySignatureResponse {
  valid: boolean;
  recovered_address: string;
  expected_address: string;
  error: string | null;
}

// Permit metadata.
export interface PermitMetadataResponse {
  token: string;
  owner: string;
  spender: string;
  current_allowance_raw: string;
  required?: boolean;
  permit_supported: boolean;
  nonce?: number;
  domain?: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
}

// Batch-quote per-item shape.
export interface BatchQuoteItem {
  ok: boolean;
  quote: SwapQuoteResponse | null;
  error: { rejectionCategory: string; message: string } | null;
}

export interface BatchQuoteResponse {
  items: BatchQuoteItem[];
}

// ─── Order endpoints ────────────────────────────────────────────────────

export interface PlaceOrderRequest {
  owner_address: string;
  side: "bid" | "ask";
  amount: string;       // human decimal
  price: string;        // human decimal (quote per base)
  order_type: "limit";
  from_address: string; // market base token
  to_address: string;   // market quote token
  order_id: string;     // UUID4
  uuid_int: string;     // composite uint256 decimal
  signature: string;
  expiration: number;
}

export interface PlaceOrderResponse {
  order_id: string;
}

export interface CancelOrderRequest {
  owner_address: string;
  order_id: string;
  uuid_int: string;
  signature: string;
}

export interface CancelAllResponse {
  cancelled: string[];
  failed: string[];
  skipped_cooldown: string[];
  total: number;
}

export interface PlaceVlBatchRequest {
  orders: PlaceOrderRequest[];
}

export interface VlAmendment {
  order_id: string;
  original_amount: string;
  actual_amount: string;
  reason: string;
}

export interface PlaceVlBatchResponse {
  order_ids: string[];
  amendments: VlAmendment[];
  cancelled: Array<{ order_id: string; reason: string }>;
  fills: Array<{
    order_id: string;
    trades: Array<{ quantity: string; price: string; counterparty_order_id: string; ts: number }>;
    remaining: string;
  }>;
  vl_group: {
    primary_id: string;
    max_budget: string;
    budget_consumed: string;
    spent_token: string;
  };
}

export interface CancelVlBatchRequest {
  owner_address: string;
  vl_batch_id: string;
  signature: string;
}

export interface SeraErrorBody {
  detail?: string | { detail?: string; error_code?: string };
}
