/**
 * tools/index.ts — Registers the full MCP tool surface.
 *
 * Each per-domain tool file exports a `register…Tools` factory; this module
 * composes them so `PdvMcpServer` registers everything with one call.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.5 — Tool surface
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "../mcp-context";
import { registerIntrospectionTools } from "./introspection";
import { registerTranslationTools } from "./translation";
import { registerTreeReadTools } from "./tree-read";

/**
 * Register every MCP tool on the given server.
 *
 * @param server - The MCP server to register tools on.
 * @param ctx - The shared tool context.
 * @returns Nothing.
 */
export function registerAllTools(server: McpServer, ctx: McpToolContext): void {
  registerTranslationTools(server, ctx);
  registerTreeReadTools(server, ctx);
  registerIntrospectionTools(server, ctx);
}
