/**
 * tools/tree-read.ts — Read-only PDV Tree MCP tools.
 *
 * `tree_list` (shallow, drill-down listing), `tree_get_node` (one node's
 * metadata, plus the on-disk file path for file-backed nodes), and
 * `tree_get_data` (a node's data payload, size-capped, summary-first).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.5 — Tool surface
 * ARCHITECTURE.md §15.6 — Tool-surface design principles
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { NodeDescriptor } from "../../pdv-protocol";
import type { McpToolContext } from "../mcp-context";
import { assertCurrentGeneration, kernelQuery, textResult } from "./_helpers";

/** Node types whose payload is a file on disk the agent should edit natively. */
const FILE_BACKED_TYPES = new Set([
  "script",
  "note",
  "markdown",
  "gui",
  "namelist",
  "lib",
  "file",
]);

/** Maximum number of characters of node data returned inline by `tree_get_data`. */
const DATA_CHAR_CAP = 8000;

/**
 * Register the read-only Tree tools.
 *
 * @param server - The MCP server to register on.
 * @param ctx - The shared tool context.
 * @returns Nothing.
 */
export function registerTreeReadTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "tree_list",
    {
      title: "List tree",
      annotations: { readOnlyHint: true },
      description:
        "List the immediate child nodes of a PDV Tree path (one level, " +
        "shallow). Omit the path or pass an empty string for the root; " +
        "drill in by listing a child's path.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Dot-delimited Tree path; omit or empty for the root."),
      },
    },
    async ({ path }, extra) => {
      assertCurrentGeneration(ctx, extra);
      const treePath = path ?? "";
      const res = await kernelQuery(ctx, "pdv.tree.list", { path: treePath });
      const nodes = (res.payload.nodes as NodeDescriptor[] | undefined) ?? [];
      if (nodes.length === 0) {
        return textResult(`(no children at "${treePath}")`);
      }
      const lines = nodes.map((n) => {
        const children = n.has_children ? ", has children" : "";
        const preview = n.preview ? ` — ${n.preview}` : "";
        return `${n.key}  [${n.type}${children}]${preview}`;
      });
      return textResult(`${treePath || "(root)"}:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "tree_get_node",
    {
      title: "Get tree node",
      annotations: { readOnlyHint: true },
      description:
        "Full metadata for one PDV Tree node: type, preview, and Python " +
        "type. For file-backed nodes (scripts, notes, GUIs, …) the on-disk " +
        "file path is included so you can read and edit the file directly.",
      inputSchema: {
        path: z.string().describe("Dot-delimited Tree path of the node."),
      },
    },
    async ({ path }, extra) => {
      assertCurrentGeneration(ctx, extra);
      const res = await kernelQuery(ctx, "pdv.tree.get", { path, mode: "preview" });
      const p = res.payload as {
        type?: string;
        preview?: string;
        python_type?: string;
        has_handler?: boolean;
      };
      const lines = [`path: ${path}`, `type: ${p.type ?? "unknown"}`];
      if (p.python_type) {
        lines.push(`python type: ${p.python_type}`);
      }
      if (p.preview) {
        lines.push(`preview: ${p.preview}`);
      }
      if (p.has_handler) {
        lines.push("has custom handler: yes");
      }
      if (p.type && FILE_BACKED_TYPES.has(p.type)) {
        try {
          const fileRes = await kernelQuery(ctx, "pdv.tree.resolve_file", { path });
          const filePath = (fileRes.payload as { file_path?: string }).file_path;
          if (filePath) {
            lines.push(`file path: ${filePath}`);
          }
        } catch {
          // resolve_file is best-effort; omit the path on failure.
        }
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "tree_get_data",
    {
      title: "Get tree node data",
      annotations: { readOnlyHint: true },
      description:
        "The actual data payload of a PDV Tree node, capped in size and led " +
        "by a type/shape summary. Use tree_get_node first to check a node's " +
        "size before fetching large payloads.",
      inputSchema: {
        path: z.string().describe("Dot-delimited Tree path of the data node."),
      },
    },
    async ({ path }, extra) => {
      assertCurrentGeneration(ctx, extra);
      const res = await kernelQuery(ctx, "pdv.tree.get", { path, mode: "value" });
      const p = res.payload as { type?: string; preview?: string; value?: unknown };
      const header =
        `path: ${path}\ntype: ${p.type ?? "unknown"}` +
        (p.preview ? `\nsummary: ${p.preview}` : "");
      let valueText: string;
      try {
        valueText = JSON.stringify(p.value, null, 2) ?? String(p.value);
      } catch {
        valueText = String(p.value);
      }
      if (valueText.length > DATA_CHAR_CAP) {
        const dropped = valueText.length - DATA_CHAR_CAP;
        valueText = `${valueText.slice(0, DATA_CHAR_CAP)}\n… (truncated; ${dropped} more characters)`;
      }
      return textResult(`${header}\n\nvalue:\n${valueText}`);
    },
  );
}
