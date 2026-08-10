/**
 * Streamable HTTP transport — for remote/web-served agent hosts (ChatGPT
 * connectors, hosted multi-tenant, web-chat backends).
 *
 * Uses `createMcpExpressApp` for automatic DNS-rebinding protection when
 * bound to localhost (per MCP spec recommendation). For non-localhost binds
 * (e.g. 0.0.0.0), pass `allowedHosts` to restrict by Host header.
 *
 * **Auth is intentionally NOT implemented here.** Going public requires
 * OAuth 2.1 + RFC 8707 Resource Indicators per MCP spec v2025-06-18. See
 * SECURITY-MODEL.md for the gap and the planned hardening path. Until OAuth
 * lands, only bind to localhost or behind a trusted reverse proxy that
 * handles auth.
 *
 * Stateful mode (sessionIdGenerator: randomUUID) is the default — required
 * for resumable sessions. Set SERA_HTTP_STATELESS=true to opt into stateless
 * mode (recommended for serverless / cloudflare-workers-like deploys).
 */
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "../util/logger.js";

export interface HttpTransportOptions {
  host: string;          // default 127.0.0.1 — DNS-rebinding protection auto-applied
  port: number;
  allowedHosts?: string[];
  stateless?: boolean;
}

export type GuardDecision =
  | { allow: true; ack: boolean }
  | { allow: false; reason: string };

/**
 * Pure-function form of the public-bind guard — returns a decision the
 * caller can act on. Used by enforcePublicBindGuard and exported for tests.
 *
 * Inputs are explicit (host, allowedHosts, ackEnv) so test runs don't
 * depend on process.env state.
 */
export function publicBindGuardDecision(
  host: string,
  allowedHosts: string[] | undefined,
  ackEnv: string | undefined,
): GuardDecision {
  const normalizedHost = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const isLoopback =
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    normalizedHost === "0:0:0:0:0:0:0:1";
  if (isLoopback) return { allow: true, ack: false };
  if (allowedHosts && allowedHosts.length > 0) return { allow: true, ack: false };
  const ack = (ackEnv ?? "false").toLowerCase() === "true";
  if (ack) return { allow: true, ack: true };
  return {
    allow: false,
    reason:
      `Streamable HTTP has no built-in auth and you're binding to a non-loopback ` +
      `host (${host}) without allowedHosts. Pick localhost, allowedHosts, or set ` +
      `SERA_HTTP_ALLOW_UNAUTHENTICATED_PUBLIC=true.`,
  };
}

/**
 * Refuses to start if binding to a non-loopback host without either:
 *  - `allowedHosts` (host-header allowlist; assumes auth-handling reverse proxy in front), OR
 *  - explicit `SERA_HTTP_ALLOW_UNAUTHENTICATED_PUBLIC=true` acknowledgment.
 *
 * Host-header validation is NOT authentication — it just stops cross-origin
 * browser-borne DNS-rebinding attacks. Public exposure without an upstream
 * auth proxy means anyone reachable on the port can call every registered
 * Sera tool. This guard is the brake that prevents accidental misdeploys.
 */
function enforcePublicBindGuard(opts: HttpTransportOptions): void {
  const decision = publicBindGuardDecision(
    opts.host,
    opts.allowedHosts,
    process.env.SERA_HTTP_ALLOW_UNAUTHENTICATED_PUBLIC,
  );
  if (decision.allow) {
    if (decision.ack) {
      log.warn(
        "SERA_HTTP_ALLOW_UNAUTHENTICATED_PUBLIC=true acknowledged — booting with no auth on non-loopback host",
        { host: opts.host, port: opts.port },
      );
    }
    return;
  }
  process.stderr.write(
    `\nrefusing to start: Streamable HTTP has no built-in auth and you're binding\n` +
      `to a non-loopback host (${opts.host}) without --allowed-hosts.\n\n` +
      `Pick one:\n` +
      `  1. Bind to localhost:                --host 127.0.0.1 (default)\n` +
      `  2. Front with an auth reverse proxy: --host ${opts.host} --allowed-hosts <your.domain>\n` +
      `  3. Acknowledge the risk:             SERA_HTTP_ALLOW_UNAUTHENTICATED_PUBLIC=true\n` +
      `                                        (anyone who reaches the port can call every Sera tool)\n\n`,
  );
  process.exit(1);
}

export async function attachStreamableHttp(
  server: McpServer,
  opts: HttpTransportOptions,
): Promise<void> {
  enforcePublicBindGuard(opts);
  const app = createMcpExpressApp({
    host: opts.host,
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
  });
  // No express.json() — StreamableHTTPServerTransport reads the raw stream
  // itself when called with two args. Pre-parsing breaks the SSE path.

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: opts.stateless ? undefined : () => randomUUID(),
  });
  await server.connect(transport);

  // Single /mcp endpoint handles POST (requests), GET (SSE stream for
  // notifications in stateful mode), DELETE (session terminate).
  // createMcpExpressApp pre-installs express.json(), so we pass req.body
  // as the 3rd arg per SDK contract.
  app.post("/mcp", (req, res) => {
    void transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", (req, res) => {
    void transport.handleRequest(req, res);
  });
  app.delete("/mcp", (req, res) => {
    void transport.handleRequest(req, res);
  });

  // Tiny health endpoint so reverse proxies can liveness-check.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "streamable_http", stateless: !!opts.stateless });
  });

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(opts.port, opts.host, () => {
      log.info("sera-mcp streamable_http listening", {
        host: opts.host,
        port: opts.port,
        stateless: !!opts.stateless,
        dns_rebinding_protection:
          opts.host === "127.0.0.1" || opts.host === "localhost" || opts.host === "::1",
      });
      resolve();
    });
    httpServer.on("error", reject);
  });
}
