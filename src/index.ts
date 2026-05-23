#!/usr/bin/env node
/**
 * sera-mcp entrypoint. Boots the MCP server over stdio.
 *
 * Server construction lives in src/server/create-server.ts (tools, resources,
 * prompts). Tool registry lives in src/tools/registry.ts. This file is only
 * transport wiring + lifecycle.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createServer, SERVER_VERSION } from "./server/create-server.js";
import { log } from "./util/logger.js";

async function main() {
  const ctx = loadConfig();
  const { server, toolsRegistered } = createServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

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
    network: ctx.cfg.network,
    base_url: ctx.cfg.baseUrl,
    signer: ctx.cfg.signerMode,
    tools: toolsRegistered,
    history: process.env.SERA_HISTORY_DB ? "enabled" : "disabled",
  });
}

main().catch((err) => {
  log.error("fatal", { error: err?.stack ?? String(err) });
  process.exit(1);
});
