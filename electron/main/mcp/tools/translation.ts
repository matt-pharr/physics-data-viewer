/**
 * tools/translation.ts — The `resolve_path` MCP tool.
 *
 * Translates between an on-disk filesystem path and a PDV Tree path. This is
 * the keystone tool: UUID-based file storage means a raw `tree/<uuid>/…`
 * path is meaningless on its own, so an agent that greps the project with
 * its native tools needs this to stay oriented in Tree terms.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.5 — Tool surface
 * pdv-python `pdv.tree.resolve_path` handler — the kernel-side resolver
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpToolContext } from "../mcp-context";
import { assertCurrentGeneration, kernelQuery, textResult } from "./_helpers";

/**
 * Register the `resolve_path` tool.
 *
 * @param server - The MCP server to register on.
 * @param ctx - The shared tool context.
 * @returns Nothing.
 */
export function registerTranslationTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "resolve_path",
    {
      title: "Resolve path",
      annotations: { readOnlyHint: true },
      description:
        "Translate between an on-disk filesystem path and a PDV Tree path. " +
        "Pass a dot-delimited Tree path to get the backing file path, or an " +
        "absolute filesystem path to get the Tree path(s) pointing at it. " +
        "PDV stores files under opaque tree/<uuid>/ directories, so use this " +
        "to map grep/find results back to Tree paths.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "A dot-delimited PDV Tree path, or an absolute filesystem path.",
          ),
      },
    },
    async ({ path }, extra) => {
      assertCurrentGeneration(ctx, extra);
      const res = await kernelQuery(ctx, "pdv.tree.resolve_path", { path });
      const payload = res.payload as {
        input?: string;
        tree_paths?: string[];
        file_path?: string | null;
      };
      const treePaths = payload.tree_paths ?? [];
      const lines: string[] = [`input: ${payload.input ?? path}`];
      if (payload.file_path) {
        lines.push(`file path: ${payload.file_path}`);
      }
      lines.push(
        treePaths.length > 0
          ? `tree path(s): ${treePaths.map((p) => `pdv_tree["${p}"]`).join(", ")}`
          : "tree path(s): (none)",
      );
      return textResult(lines.join("\n"));
    },
  );
}
