/**
 * tools/tree-mutate.ts — Mutating PDV Tree MCP tools.
 *
 * `create_tree_node` (dispatches by node type), `delete_tree_node` (gated
 * behind a PDV-side native confirmation dialog), and `move_tree_node`
 * (rename + relocate via the same tool — UUID storage decouples the tree
 * path from the on-disk path).
 *
 * Mutating tools are register-but-throw gated by the
 * `mcp.mutatingToolsEnabled` setting (ARCHITECTURE.md §15.5, §15.10): every
 * tool is registered so the schema is stable, but each call first calls
 * `assertMutatingToolsEnabled` and throws a clear "disabled in Settings"
 * error when the toggle is off.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.5 — Tool surface (mutating tier)
 * ARCHITECTURE.md §15.10 — Settings: the Agents pane
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import { z } from "zod";

import { PDVMessageType } from "../../pdv-protocol";
import type { McpToolContext } from "../mcp-context";
import {
  assertCurrentGeneration,
  assertMutatingToolsEnabled,
  kernelMutate,
  textResult,
} from "./_helpers";

/**
 * Register the mutating Tree tools.
 *
 * @param server - The MCP server to register on.
 * @param ctx - The shared tool context.
 * @returns Nothing.
 */
export function registerTreeMutateTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "create_tree_node",
    {
      title: "Create tree node",
      description:
        "Create a PDV Tree node at `parent_path` named `name`. For file-" +
        "backed types (`script`, `note`) the backing file is allocated under " +
        "`tree/<uuid>/` and its absolute path is returned; the agent then " +
        "edits the file with its own tools. `dict` creates an empty sub-tree.",
      inputSchema: {
        type: z
          .enum(["dict", "script", "note", "lib"])
          .describe(
            "Node type. `dict` = empty sub-tree; `script` = Python/Julia " +
              "PDVScript; `note` = Markdown note; `lib` = importable " +
              "Python module other scripts can `from … import`.",
          ),
        parent_path: z
          .string()
          .describe(
            "Dot-delimited Tree path of the parent. Empty string for root.",
          ),
        name: z
          .string()
          .describe(
            "Name of the new node (used as the key under `parent_path`).",
          ),
      },
    },
    async ({ type, parent_path, name }, extra) => {
      assertCurrentGeneration(ctx, extra);
      assertMutatingToolsEnabled(ctx);
      const kernelId = ctx.hooks.getActiveKernelId();
      if (!kernelId) {
        throw new Error(
          "No active PDV kernel. Open a project in PDV before creating nodes.",
        );
      }
      if (!name.trim()) {
        throw new Error("`name` must be a non-empty string.");
      }

      if (type === "dict") {
        const res = await kernelMutate(ctx, PDVMessageType.TREE_CREATE_NODE, {
          parent_path,
          name,
        });
        const newPath = (res.payload as { path?: string }).path;
        return textResult(
          `Created dict node at ${newPath ?? `${parent_path}.${name}`}`,
        );
      }
      if (type === "script") {
        const result = await ctx.hooks.treeCreate.script(
          kernelId,
          parent_path,
          name,
        );
        if (!result.success || !result.scriptPath || !result.treePath) {
          throw new Error(result.error ?? "Script creation failed.");
        }
        const stub = await readFileSafe(result.scriptPath);
        const stubBlock = stub === null ? "" : `\n\ncurrent stub:\n${stub}`;
        return textResult(
          `Created script:\n  tree path: ${result.treePath}\n  file path: ${result.scriptPath}\n` +
            `Edit the file with your file tools; it already has a ` +
            `run(pdv_tree, **params) -> dict stub.${stubBlock}\n\n` +
            FILE_BACKED_HINT,
        );
      }
      if (type === "lib") {
        const result = await ctx.hooks.treeCreate.lib(
          kernelId,
          parent_path,
          name,
        );
        if (!result.success || !result.libPath || !result.treePath) {
          throw new Error(result.error ?? "Lib creation failed.");
        }
        const stub = await readFileSafe(result.libPath);
        const stubBlock = stub === null ? "" : `\n\ncurrent contents:\n${stub}`;
        return textResult(
          `Created lib:\n  tree path: ${result.treePath}\n  file path: ${result.libPath}\n` +
            `Edit the file with your file tools; importable from other PDV ` +
            `scripts as a Python module.${stubBlock}\n\n${FILE_BACKED_HINT}`,
        );
      }
      // type === "note"
      const result = await ctx.hooks.treeCreate.note(kernelId, parent_path, name);
      if (!result.success || !result.notePath || !result.treePath) {
        throw new Error(result.error ?? "Note creation failed.");
      }
      return textResult(
        `Created note:\n  tree path: ${result.treePath}\n  file path: ${result.notePath}\n` +
          `current contents: (empty)\n\n${FILE_BACKED_HINT}`,
      );
    },
  );

  server.registerTool(
    "delete_tree_node",
    {
      title: "Delete tree node",
      description:
        "Delete a PDV Tree node by path. PDV ALWAYS shows the user a native " +
        "confirmation dialog before the deletion is sent to the kernel — the " +
        "agent cannot bypass this. The tool returns only after the user " +
        "responds (or after a 60-second timeout, treated as a refusal).",
      inputSchema: {
        path: z
          .string()
          .describe("Dot-delimited Tree path of the node to delete."),
      },
    },
    async ({ path }, extra) => {
      assertCurrentGeneration(ctx, extra);
      assertMutatingToolsEnabled(ctx);
      const confirmed = await promptDeleteConfirmation(ctx, path);
      if (!confirmed) {
        throw new Error(
          `User refused to delete "${path}" (or did not respond within 60s).`,
        );
      }
      await kernelMutate(ctx, PDVMessageType.TREE_DELETE, { path });
      return textResult(`Deleted ${path}`);
    },
  );

  server.registerTool(
    "move_tree_node",
    {
      title: "Move tree node",
      description:
        "Move or rename a PDV Tree node. UUID storage decouples the tree " +
        "path from the on-disk path — this tool reshuffles the tree only; " +
        "file paths under `tree/<uuid>/` are unaffected. If the parent path " +
        "is unchanged the operation is a rename; otherwise it is a move.",
      inputSchema: {
        from_path: z
          .string()
          .describe("Dot-delimited Tree path of the node to move."),
        to_path: z
          .string()
          .describe("Target dot-delimited Tree path (parent + new name)."),
      },
    },
    async ({ from_path, to_path }, extra) => {
      assertCurrentGeneration(ctx, extra);
      assertMutatingToolsEnabled(ctx);
      const fromParent = parentOf(from_path);
      const toParent = parentOf(to_path);
      const toName = leafOf(to_path);
      if (fromParent === toParent) {
        // Same parent → rename to the new leaf name.
        await kernelMutate(ctx, PDVMessageType.TREE_RENAME, {
          path: from_path,
          new_name: toName,
        });
        return textResult(`Renamed ${from_path} → ${to_path}`);
      }
      await kernelMutate(ctx, PDVMessageType.TREE_MOVE, {
        path: from_path,
        new_path: to_path,
      });
      return textResult(`Moved ${from_path} → ${to_path}`);
    },
  );
}

/**
 * Show the user a native delete-confirmation dialog (via the injected
 * `ctx.confirm`). Returns `true` only when the user explicitly clicks
 * "Delete". Closing the dialog or letting it sit for 60 seconds is treated
 * as a refusal so an agent cannot wait the user out.
 *
 * @param ctx - Tool context providing the injected confirm dialog.
 * @param path - The dot-delimited tree path the agent wants to delete.
 * @returns `true` if the user confirmed, `false` otherwise.
 */
async function promptDeleteConfirmation(
  ctx: McpToolContext,
  path: string,
): Promise<boolean> {
  const dialogPromise = ctx.confirm({
    type: "warning",
    title: "Confirm Tree Node Deletion",
    message: `An AI agent is requesting to delete "${path}".`,
    detail:
      "This permanently removes the node from the PDV Tree (and its " +
      "backing file, if any). Click Delete to confirm, or Cancel to refuse.",
    buttons: ["Cancel", "Delete"],
    defaultId: 0,
    cancelId: 0,
  });
  // Promise.race doesn't cancel the losing promise, so an idle 60s
  // setTimeout would keep the process from quitting cleanly between a
  // user's quick click and the timer's expiry. Clear the timer when the
  // dialog resolves first.
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<number>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(0), 60_000);
  });
  try {
    const response = await Promise.race([dialogPromise, timeoutPromise]);
    return response === 1;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Hint included in every file-backed `create_tree_node` response so an agent
 * whose file-write tool requires a prior Read of the file (Claude Code etc.)
 * knows to do that before overwriting the freshly-allocated stub.
 */
const FILE_BACKED_HINT =
  "Tip: if your file-write tool requires a prior Read of the path, Read this " +
  "file before Write — it exists on disk now but your harness's read-cache " +
  "doesn't know about it yet.";

/**
 * Read the contents of a freshly-created stub file. Best-effort: if the read
 * fails (the file disappeared, permission, etc.) we return null and the
 * caller omits the inline-contents block. Capped so a huge templated file
 * (none exist today, but be safe) doesn't bloat the tool response.
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  const MAX_LEN = 4000;
  try {
    const text = await fs.readFile(filePath, "utf-8");
    if (text.length > MAX_LEN) {
      return `${text.slice(0, MAX_LEN)}\n… (truncated; ${text.length - MAX_LEN} more chars)`;
    }
    return text;
  } catch {
    return null;
  }
}

/** Parent path of a dot-delimited tree path (`"a.b.c"` → `"a.b"`). */
function parentOf(treePath: string): string {
  const dot = treePath.lastIndexOf(".");
  return dot < 0 ? "" : treePath.slice(0, dot);
}

/** Leaf name of a dot-delimited tree path (`"a.b.c"` → `"c"`). */
function leafOf(treePath: string): string {
  const dot = treePath.lastIndexOf(".");
  return dot < 0 ? treePath : treePath.slice(dot + 1);
}
