/**
 * MCP server construction. Single source of truth for which tools, resources,
 * and prompts get registered.
 *
 * The bootstrap entry (src/index.ts) only handles transport wiring + lifecycle.
 * Anything tool-shaped lives here or in src/tools/registry.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { AppContext } from "../config.js";
import { TOOLS, type ToolDef } from "../tools/registry.js";
import { listResources, readResource } from "../resources.js";
import { listPrompts, getPrompt } from "../prompts.js";
import { log } from "../util/logger.js";

const VERSION = "0.8.1";

export function createServer(ctx: AppContext): {
  server: McpServer;
  toolsRegistered: number;
} {
  const server = new McpServer(
    { name: "sera-mcp", version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // ── tools ───────────────────────────────────────────────────────────────
  // Tool filtering:
  //   - execution category is gated on SERA_ENABLE_EXECUTION_TOOLS (default true)
  //   - convert_and_send additionally requires SERA_SIGNER_MODE=local (the tool
  //     CAN'T work without it — surfacing it when it always fails just makes
  //     the agent reason wrong)
  let registered = 0;
  for (const t of TOOLS) {
    if (t.category === "execution" && !ctx.cfg.enableExecutionTools) continue;
    if (t.name === "sera.convert_and_send" && ctx.cfg.signerMode !== "local") {
      continue;
    }
    registerTool(server, ctx, t);
    registered++;
  }

  // ── resources ───────────────────────────────────────────────────────────
  // McpServer exposes the underlying Server via .server for low-level handler
  // registration. resources.ts ships pre-formed descriptors and a fetcher;
  // wiring them through registerResource would require dynamic templating that
  // doesn't fit the static list shape. Reuse the existing handlers.
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(),
  }));
  server.server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = await readResource(ctx, req.params.uri);
    return { contents: [r] };
  });

  // ── prompts ─────────────────────────────────────────────────────────────
  // Prompts ship through src/prompts.ts with strict per-arg sanitization
  // (see src/util/sanitize.ts). Keep the existing handlers — they validate
  // arg shapes BEFORE substitution into LLM message bodies, which is the
  // load-bearing security property; routing through registerPrompt would
  // weaken that.
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: listPrompts(),
  }));
  server.server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    return getPrompt(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, string>,
    );
  });

  return { server, toolsRegistered: registered };
}

/**
 * Register one tool against an McpServer. Wraps the handler so:
 *   - args are validated by the tool's Zod schema (server-side, before run)
 *   - duration is logged
 *   - thrown errors become structured tool errors (isError: true)
 *   - successful results are returned as JSON-stringified text content
 *     (compatible with existing host expectations)
 */
function registerTool(
  server: McpServer,
  ctx: AppContext,
  t: ToolDef,
): void {
  server.registerTool(
    t.name,
    {
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      annotations: t.annotations,
    },
    async (rawArgs: unknown) => {
      try {
        const parsed = t.inputSchema.parse(rawArgs ?? {});
        const t0 = Date.now();
        const result = await t.handler(ctx, parsed);
        log.debug("tool ok", { tool: t.name, ms: Date.now() - t0 });
        // structuredContent is emitted whenever outputSchema is declared on
        // the tool. Hosts that validate/render structured output use this
        // alongside the human-readable text content.
        const text = JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text" as const, text }],
          ...(t.outputSchema
            ? { structuredContent: result as Record<string, unknown> }
            : {}),
        };
      } catch (err: any) {
        log.warn("tool error", {
          tool: t.name,
          error: err?.message ?? String(err),
        });
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error in ${t.name}: ${err?.message ?? String(err)}`,
            },
          ],
        };
      }
    },
  );
}

export const SERVER_VERSION = VERSION;
