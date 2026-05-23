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

export async function attachStreamableHttp(
  server: McpServer,
  opts: HttpTransportOptions,
): Promise<void> {
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
