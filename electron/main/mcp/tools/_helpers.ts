/**
 * tools/_helpers.ts — Shared helpers for MCP tool implementations.
 *
 * Provides the read-only kernel-query helper, the generation-staleness
 * guard, and a result-formatting shortcut used by every tool file.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.3 — Session binding and staleness
 * ARCHITECTURE.md §15.6 — Tool-surface design principles
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import type { PDVMessage } from "../../pdv-protocol";
import type { McpToolContext } from "../mcp-context";

/** The `extra` argument an SDK tool callback receives. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Send a read-only query to the kernel, preferring the dedicated query
 * socket and falling back to the comm channel.
 *
 * @param ctx - The MCP tool context.
 * @param type - PDV message type (e.g. `'pdv.tree.list'`).
 * @param payload - Request payload.
 * @returns The kernel's response message.
 * @throws {Error} When no kernel is running, or the kernel reports an error.
 */
export async function kernelQuery(
  ctx: McpToolContext,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<PDVMessage> {
  const kernelId = ctx.hooks.getActiveKernelId();
  if (!kernelId || !ctx.kernelManager.getKernel(kernelId)) {
    throw new Error(
      "No active PDV kernel. Open a project in PDV before using this tool.",
    );
  }
  if (ctx.queryRouter.isAttached()) {
    return ctx.queryRouter.request(type, payload);
  }
  return ctx.commRouter.request(type, payload);
}

/**
 * Throw if the calling MCP session connected before the current
 * project/kernel generation — i.e. the project or kernel changed underneath
 * the agent (ARCHITECTURE.md §15.3).
 *
 * @param ctx - The MCP tool context.
 * @param extra - The SDK tool-callback `extra` (carries the session id).
 * @throws {Error} When the session is stale.
 */
export function assertCurrentGeneration(ctx: McpToolContext, extra: ToolExtra): void {
  const connectedAt = ctx.getSessionGeneration(extra.sessionId);
  if (connectedAt !== undefined && connectedAt !== ctx.hooks.getGeneration()) {
    throw new Error(
      "PDV's project or kernel has changed since this MCP session connected. " +
        "Reconnect the MCP client to continue.",
    );
  }
}

/**
 * Wrap plain text as a successful MCP tool result.
 *
 * @param text - The result text.
 * @returns A `CallToolResult` carrying a single text block.
 */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
