#!/usr/bin/env node
/**
 * sera-mcp entrypoint.
 *
 * Default transport: stdio (Claude Code, Claude Desktop, Cursor, OpenAI Agents
 * SDK `MCPServerStdio`). Override with `--transport http` for Streamable HTTP
 * (for ChatGPT connectors, hosted multi-tenant, web-chat backends).
 *
 * Server construction lives in src/server/create-server.ts. Tool registry
 * lives in src/tools/registry.ts.
 */

import { loadConfig } from "./config.js";
import { createServer, SERVER_VERSION } from "./server/create-server.js";
import { attachStdio } from "./transports/stdio.js";
import { attachStreamableHttp } from "./transports/http.js";
import { log } from "./util/logger.js";

type Transport = "stdio" | "http";

interface CliOpts {
  transport: Transport;
  host: string;
  port: number;
  allowedHosts?: string[];
  stateless: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    transport: (process.env.SERA_TRANSPORT as Transport) ?? "stdio",
    host: process.env.SERA_HTTP_HOST ?? "127.0.0.1",
    port: Number(process.env.SERA_HTTP_PORT ?? 3848),
    stateless: (process.env.SERA_HTTP_STATELESS ?? "false").toLowerCase() === "true",
  };
  const allowed = process.env.SERA_HTTP_ALLOWED_HOSTS;
  if (allowed) opts.allowedHosts = allowed.split(",").map((s) => s.trim()).filter(Boolean);

  // CLI flags override env.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transport") {
      const v = argv[++i] as Transport | undefined;
      if (v !== "stdio" && v !== "http") {
        throw new Error(`--transport must be 'stdio' or 'http' (got '${v}')`);
      }
      opts.transport = v;
    } else if (a === "--host") opts.host = argv[++i] ?? opts.host;
    else if (a === "--port") opts.port = Number(argv[++i] ?? opts.port);
    else if (a === "--stateless") opts.stateless = true;
    else if (a === "--allowed-hosts") {
      const v = argv[++i] ?? "";
      opts.allowedHosts = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ctx = loadConfig();
  const { server, toolsRegistered } = createServer(ctx);

  if (opts.transport === "stdio") {
    await attachStdio(server);
  } else {
    await attachStreamableHttp(server, {
      host: opts.host,
      port: opts.port,
      allowedHosts: opts.allowedHosts,
      stateless: opts.stateless,
    });
  }

  // Best-effort network-label sanity check. Doesn't block startup.
  try {
    const cfg = await ctx.sera.getConfig();
    const chainId = Number(cfg.chain_id);
    const expected = ctx.cfg.network === "mainnet" ? 1 : 11155111;
    if (Number.isFinite(chainId) && chainId !== expected) {
      log.warn("network label mismatch", {
        SERA_NETWORK: ctx.cfg.network,
        chain_id: chainId,
        expected,
      });
    }
  } catch (e: any) {
    log.warn("config probe failed", { error: e?.message ?? String(e) });
  }

  log.info("sera-mcp ready", {
    version: SERVER_VERSION,
    transport: opts.transport,
    network: ctx.cfg.network,
    base_url: ctx.cfg.baseUrl,
    signer: ctx.cfg.signerMode,
    tools: toolsRegistered,
    history: process.env.SERA_HISTORY_DB ? "enabled" : "disabled",
    ...(opts.transport === "http" ? { http_host: opts.host, http_port: opts.port } : {}),
  });
}

main().catch((err) => {
  log.error("fatal", { error: err?.stack ?? String(err) });
  process.exit(1);
});
