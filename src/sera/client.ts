import { request } from "undici";
import type {
  BalancesResponse,
  FxRateResponse,
  SeraConfig,
  SeraMarket,
  SeraToken,
  SwapExecuteRequest,
  SwapExecuteResponse,
  SwapQuoteRequest,
  SwapQuoteResponse,
} from "./types.js";
import { TtlCache } from "../util/cache.js";
import { recordFx } from "../util/persistence.js";

export interface SeraClientOptions {
  baseUrl: string;
  apiKey?: string;
  apiSecret?: string;
}

// Cache TTLs by endpoint character — picked to balance freshness vs traffic.
const TTL_TOKENS_MS = 5 * 60_000;
const TTL_MARKETS_MS = 10 * 60_000;
const TTL_CONFIG_MS = 60 * 60_000;
const TTL_SYSTIME_MS = 5_000;
const TTL_FX_MS = 60_000;

// Retry-After handling for transient 503s. Per Sera docs, "Server failures
// (5xx) mapped to 503 with Retry-After: 1 header". Only safe for GET (read
// idempotent); POST mutations never auto-retry (could double-execute).
const MAX_RETRIES_GET = 2;
const RETRY_AFTER_FALLBACK_MS = 1_000;
const RETRY_AFTER_CAP_MS = 5_000;

// Read endpoints expect lowercase owner_address (per docs). EIP-712 signed
// payloads accept EIP-55 checksum. Normalize at the read boundary.
export function lowerOwner(addr: string): string {
  return addr.toLowerCase();
}

export class SeraApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string | undefined,
    message: string,
    public body: unknown,
  ) {
    super(message);
    this.name = "SeraApiError";
  }
}

export class SeraClient {
  private readonly tokensCache = new TtlCache<{ tokens: SeraToken[] }>(TTL_TOKENS_MS);
  private readonly marketsCache = new TtlCache<{ markets: SeraMarket[] }>(TTL_MARKETS_MS);
  private readonly configCache = new TtlCache<SeraConfig>(TTL_CONFIG_MS);
  private readonly systimeCache = new TtlCache<{ timestamp: number }>(TTL_SYSTIME_MS);
  private readonly fxCache = new TtlCache<FxRateResponse>(TTL_FX_MS);

  constructor(private readonly opts: SeraClientOptions) {}

  private get authHeader(): Record<string, string> {
    if (this.opts.apiKey && this.opts.apiSecret) {
      return {
        Authorization: `Bearer ${this.opts.apiKey}:${this.opts.apiSecret}`,
      };
    }
    return {};
  }

  private async call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.opts.baseUrl.replace(/\/+$/, "") + path);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...(init.auth ? this.authHeader : {}),
    };

    const maxAttempts = method === "GET" ? 1 + MAX_RETRIES_GET : 1;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt++;
      const res = await request(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        // Refuse redirects entirely. The base URL is allowlisted; a 30x to
        // anywhere else (including a sera.cx subdomain) would defeat that gate.
        maxRedirections: 0,
      });
      const text = await res.body.text();
      let parsed: unknown = undefined;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }

      // Honor Retry-After on 503 for read-only methods. Per Sera docs all
      // 5xx are mapped to 503 with Retry-After: 1. POSTs are never retried —
      // a transient 503 mid-execute could land server-side after we time out
      // locally; auto-retrying would double-execute.
      if (res.statusCode === 503 && method === "GET" && attempt < maxAttempts) {
        const retryAfter = res.headers["retry-after"];
        const waitMs = parseRetryAfter(retryAfter);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (res.statusCode >= 400) {
        // Sera observed shapes:
        //   { detail: "Invalid request" }
        //   { detail: { detail: "...", error_code: "..." } }
        //   { detail: { success: false, error: "no_liquidity" } }   // /swap/quote business errors
        const detail = (parsed as any)?.detail;
        let errorCode: string | undefined;
        let message: string;
        if (typeof detail === "string") {
          message = detail;
        } else if (detail && typeof detail === "object") {
          errorCode = (detail.error_code as string | undefined) ?? (detail.error as string | undefined);
          message =
            (detail.detail as string | undefined) ??
            (detail.error as string | undefined) ??
            `Sera ${res.statusCode} ${method} ${path}`;
        } else {
          message = `Sera ${res.statusCode} ${method} ${path}`;
        }
        lastErr = new SeraApiError(res.statusCode, errorCode, message, parsed);
        throw lastErr;
      }
      return parsed as T;
    }
    // Exhausted GET retries on 503.
    throw lastErr ?? new SeraApiError(503, undefined, `Sera ${method} ${path} exhausted retries`, undefined);
  }

  // ---- Public / unauthenticated (cached) ----
  // All read endpoints share a TtlCache with in-flight de-dupe — fan-outs that
  // request the same key concurrently collapse to one upstream request.
  async getTokens(): Promise<{ tokens: SeraToken[] }> {
    return this.tokensCache.get("_", () => this.call("GET", "/tokens"));
  }

  async getMarkets(): Promise<{ markets: SeraMarket[] }> {
    return this.marketsCache.get("_", () => this.call("GET", "/markets"));
  }

  async getConfig(): Promise<SeraConfig> {
    return this.configCache.get("_", () => this.call("GET", "/config"));
  }

  async getSystemTime(): Promise<{ timestamp: number }> {
    return this.systimeCache.get("_", () => this.call("GET", "/system/time"));
  }

  async getHealth(): Promise<{ status: string; executor_id?: number | string }> {
    // Never cache health — it's the explicit "tell me state right now" call.
    return this.call("GET", "/health");
  }

  async getFxRate(base: string, quote: string): Promise<FxRateResponse> {
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    return this.fxCache.get(`${b}/${q}`, async () => {
      const r = await this.call<FxRateResponse>("GET", "/fx/rate", { query: { base: b, quote: q } });
      const num = Number(r.rate);
      if (Number.isFinite(num) && num > 0) recordFx(b, q, num);
      return r;
    });
  }

  async postSwapQuote(req: SwapQuoteRequest): Promise<SwapQuoteResponse> {
    return this.call("POST", "/swap/quote", { body: req });
  }

  async postSwap(req: SwapExecuteRequest): Promise<SwapExecuteResponse> {
    return this.call("POST", "/swap", { body: req });
  }

  // ---- API-key-authenticated reads ----
  // owner_address normalized to lowercase per Sera docs ("Read endpoints
  // treat owner_address as case-sensitive; use lowercase form"). EIP-712
  // signed payloads accept EIP-55 checksum and are NOT normalized here.
  async getBalances(ownerAddress: string): Promise<BalancesResponse> {
    return this.call("GET", "/balances", {
      query: { owner_address: lowerOwner(ownerAddress) },
      auth: true,
    });
  }

  /**
   * Order/trade history. Sera returns 401 without auth — surface a clear gate
   * upstream when SERA_API_KEY is missing. owner_address (if present in
   * filters) lowercased automatically.
   */
  async getOrders(filters: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const q = { ...filters };
    if (typeof q.owner_address === "string") q.owner_address = lowerOwner(q.owner_address);
    return this.call("GET", "/orders", { query: q, auth: true });
  }
}

/**
 * Parse HTTP Retry-After header. Accepts seconds (integer) or HTTP-date.
 * Falls back to RETRY_AFTER_FALLBACK_MS, caps at RETRY_AFTER_CAP_MS to
 * prevent a hostile/buggy upstream from pinning us indefinitely.
 *
 * Exported for unit testing.
 */
export function parseRetryAfter(header: string | string[] | undefined): number {
  if (!header) return RETRY_AFTER_FALLBACK_MS;
  const value = Array.isArray(header) ? header[0] : header;
  const asInt = Number.parseInt(value, 10);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(asInt * 1_000, RETRY_AFTER_CAP_MS);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const ms = asDate - Date.now();
    if (ms > 0) return Math.min(ms, RETRY_AFTER_CAP_MS);
  }
  return RETRY_AFTER_FALLBACK_MS;
}
