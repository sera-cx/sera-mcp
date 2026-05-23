/**
 * Stdio transport — the default and recommended path for local agent hosts
 * (Claude Code, Claude Desktop, Cursor, OpenAI Agents SDK `MCPServerStdio`).
 *
 * Stdin / stdout carry the MCP JSON-RPC frames. Stderr is reserved for
 * structured logs (see src/util/logger.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function attachStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
