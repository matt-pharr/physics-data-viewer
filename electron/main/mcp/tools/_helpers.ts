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
 * Send a write/mutation message to the kernel. Mutating messages always go
 * through `CommRouter`; the read-only query socket whitelist would reject
 * them (`query.not_allowed`).
 *
 * @param ctx - The MCP tool context.
 * @param type - PDV message type (e.g. `'pdv.tree.delete'`).
 * @param payload - Request payload.
 * @returns The kernel's response message.
 * @throws {Error} When no kernel is running, or the kernel reports an error.
 */
export async function kernelMutate(
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
  return ctx.commRouter.request(type, payload);
}

/**
 * Throw the "disabled in Settings" error a mutating MCP tool must raise when
 * the `mcp.mutatingToolsEnabled` config toggle is off. The tool stays
 * registered (stable schema) so the agent's client sees a clear, actionable
 * error rather than a missing-tool failure.
 *
 * @param ctx - The MCP tool context.
 * @throws {Error} When mutating tools are disabled.
 */
export function assertMutatingToolsEnabled(ctx: McpToolContext): void {
  const cfg = ctx.configStore.get("mcp");
  if (!cfg?.mutatingToolsEnabled) {
    throw new Error(
      "Mutating MCP tools are disabled. Enable them in PDV under " +
        "Settings → Agents → Allow mutating tools.",
    );
  }
}

/**
 * Companion to {@link assertMutatingToolsEnabled} for the most-powerful tool,
 * `pdv_run`, which is gated by its own switch (`mcp.pdvRunEnabled`).
 *
 * @param ctx - The MCP tool context.
 * @throws {Error} When `pdv_run` is disabled.
 */
export function assertPdvRunEnabled(ctx: McpToolContext): void {
  const cfg = ctx.configStore.get("mcp");
  if (!cfg?.pdvRunEnabled) {
    throw new Error(
      "The pdv_run tool is disabled. Enable it in PDV under " +
        "Settings → Agents → Allow pdv_run (arbitrary kernel code).",
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
