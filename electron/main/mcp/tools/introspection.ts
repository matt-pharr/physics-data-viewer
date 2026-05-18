/**
 * tools/introspection.ts — Kernel- and project-introspection MCP tools.
 *
 * `namespace_list` (kernel namespace variables), `pdv_help` (live signature
 * and docstring for any symbol), and `project_info` (the PDV instance and
 * the open project).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.5 — Tool surface
 * ARCHITECTURE.md §15.11 — Documentation exposure
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpToolContext } from "../mcp-context";
import { assertCurrentGeneration, kernelQuery, textResult } from "./_helpers";

/**
 * Register the introspection tools.
 *
 * @param server - The MCP server to register on.
 * @param ctx - The shared tool context.
 * @returns Nothing.
 */
export function registerIntrospectionTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "namespace_list",
    {
      title: "List kernel namespace",
      annotations: { readOnlyHint: true },
      description:
        "List the variables currently defined in the PDV kernel namespace.",
      inputSchema: {
        include_private: z
          .boolean()
          .optional()
          .describe("Include names starting with an underscore."),
        include_modules: z
          .boolean()
          .optional()
          .describe("Include imported modules."),
        include_callables: z
          .boolean()
          .optional()
          .describe("Include functions and classes."),
      },
    },
    async ({ include_private, include_modules, include_callables }, extra) => {
      assertCurrentGeneration(ctx, extra);
      const res = await kernelQuery(ctx, "pdv.namespace.query", {
        include_private: include_private ?? false,
        include_modules: include_modules ?? false,
        include_callables: include_callables ?? false,
      });
      const variables =
        (res.payload.variables as Record<string, unknown> | undefined) ?? {};
      const names = Object.keys(variables);
      if (names.length === 0) {
        return textResult("(kernel namespace is empty)");
      }
      const lines = names.map((name) => {
        const d = variables[name] as { type?: string; preview?: string } | undefined;
        return `${name}  [${d?.type ?? "?"}]${d?.preview ? ` — ${d.preview}` : ""}`;
      });
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "pdv_help",
    {
      title: "PDV API help",
      annotations: { readOnlyHint: true },
      description:
        "Introspect a Python symbol — the pdv library API (e.g. " +
        "'pdv.add_file'), a PDV class ('PDVTree', 'PDVScript'), or any " +
        "variable in the kernel namespace. Returns kind, signature, and " +
        "docstring; optionally the source.",
      inputSchema: {
        symbol: z
          .string()
          .describe("Symbol to introspect, e.g. 'pdv.add_file' or 'PDVScript'."),
        include_source: z
          .boolean()
          .optional()
          .describe("Also return the source code of the symbol."),
      },
    },
    async ({ symbol, include_source }, extra) => {
      assertCurrentGeneration(ctx, extra);
      const res = await kernelQuery(ctx, "pdv.help", {
        symbol,
        include_source: include_source ?? false,
      });
      const p = res.payload as {
        symbol?: string;
        kind?: string;
        signature?: string | null;
        doc?: string | null;
        source?: string | null;
      };
      const lines = [`symbol: ${p.symbol ?? symbol}`, `kind: ${p.kind ?? "unknown"}`];
      if (p.signature) {
        lines.push(`signature: ${p.signature}`);
      }
      if (p.doc) {
        lines.push(`\n${p.doc}`);
      }
      if (p.source) {
        lines.push(`\nsource:\n${p.source}`);
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "project_info",
    {
      title: "PDV project info",
      annotations: { readOnlyHint: true },
      description:
        "Summary of the running PDV instance: app version, the open " +
        "project directory, and kernel status.",
      inputSchema: {},
    },
    async (_args, extra) => {
      assertCurrentGeneration(ctx, extra);
      const projectDir = ctx.hooks.getActiveProjectDir();
      const kernelId = ctx.hooks.getActiveKernelId();
      const kernel = kernelId ? ctx.kernelManager.getKernel(kernelId) : undefined;
      const lines = [
        `PDV version: ${ctx.appVersion}`,
        `project: ${projectDir ?? "(no project open)"}`,
        `kernel: ${kernel ? `${kernel.language} (${kernel.status})` : "(no kernel running)"}`,
        `generation: ${ctx.hooks.getGeneration()}`,
      ];
      return textResult(lines.join("\n"));
    },
  );
}
