/**
 * tools/execution.ts — MCP tools that run code in the live PDV kernel.
 *
 * Surface (ARCHITECTURE.md §15.5):
 * - `script_run`  — run a `PDVScript` via the existing `script.run()` path,
 *   tagged with `origin: agent`.
 * - `pdv_run`     — execute a raw Python (or Julia) string in the kernel.
 *   Gated behind its own settings switch (`mcp.pdvRunEnabled`).
 * - `cell_list`   — list the renderer's code-cell tabs.
 * - `cell_read`   — read one cell tab's source.
 * - `cell_write`  — overwrite one cell tab's source (or append a new tab).
 * - `cell_run`    — read a cell tab and run its code (origin: agent).
 *
 * Every execution flows through {@link executeAndTranscribe} so the
 * §15.7 transcript captures it. The structured summary returned to the
 * agent carries status, duration, the final lines of output, and a
 * pointer to the transcript file for full-output grepping.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.5 — Tool surface
 * ARCHITECTURE.md §15.7 — Execution output and the transcript
 * ARCHITECTURE.md §15.8 — Renderer interaction
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { IPC } from "../../ipc";
import type {
  KernelExecuteResult,
  KernelExecutionOrigin,
} from "../../kernel-manager";
import { PDVMessageType } from "../../pdv-protocol";
import type { McpToolContext } from "../mcp-context";
import { executeAndTranscribe, TranscriptWriter } from "../transcript";
import {
  assertCellReadFresh,
  assertCurrentGeneration,
  assertMutatingToolsEnabled,
  assertPdvRunEnabled,
  textResult,
} from "./_helpers";

/** Maximum number of trailing output lines included in a tool summary. */
const SUMMARY_TAIL_LINES = 50;

/**
 * Register the execution tools (`script_run`, `pdv_run`, and the cell tools).
 *
 * @param server - The MCP server to register on.
 * @param ctx - The shared tool context.
 * @returns Nothing.
 */
export function registerExecutionTools(server: McpServer, ctx: McpToolContext): void {
  // ---------------------------------------------------------------------------
  // script_run
  // ---------------------------------------------------------------------------
  server.registerTool(
    "script_run",
    {
      title: "Run PDV script",
      description:
        "Run a PDVScript at the given Tree path with the given params, " +
        "exactly like the user clicking Run. The run is tagged " +
        "`origin: agent` so the console and transcript attribute it to the " +
        "agent. Returns a structured summary plus a pointer to the full " +
        "transcript file (read it with your own grep/tail).",
      inputSchema: {
        tree_path: z
          .string()
          .describe(
            "Dot-delimited Tree path of the script node (e.g. `scripts.fit`).",
          ),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Keyword arguments forwarded to the script's `run(...)` call.",
          ),
      },
    },
    async ({ tree_path, params }, extra) => {
      assertCurrentGeneration(ctx, extra);
      assertMutatingToolsEnabled(ctx);
      const kernelId = requireKernel(ctx);
      const kernel = ctx.kernelManager.getKernel(kernelId);
      if (!kernel) throw new Error("Kernel disappeared during call.");

      await runLibReloadPreflight(ctx, tree_path);
      const code = buildScriptInvocation(
        kernel.language,
        tree_path,
        params ?? {},
      );
      const origin: KernelExecutionOrigin = {
        kind: "agent",
        agentTool: "script_run",
        scriptPath: tree_path,
      };
      const result = await runOnKernel(ctx, code, origin);
      return textResult(formatExecutionSummary(result, ctx, origin));
    },
  );

  // ---------------------------------------------------------------------------
  // pdv_run
  // ---------------------------------------------------------------------------
  server.registerTool(
    "pdv_run",
    {
      title: "Run code in the PDV kernel",
      description:
        "Execute one or more lines of code in the live PDV kernel and " +
        "return a summary. The kernel is the same one the user is working " +
        "in — variables persist. Output and code are recorded in the " +
        "transcript and visible in the Console. Use this for one-off " +
        "experiments; persistent code belongs in a `script` or `cell`. " +
        "This tool can be disabled in Settings → Agents.",
      inputSchema: {
        code: z.string().describe("Source code to execute (Python or Julia)."),
      },
    },
    async ({ code }, extra) => {
      assertCurrentGeneration(ctx, extra);
      // pdv_run requires BOTH gates: it is a mutating-tier tool (it can
      // write the Tree, files, and run subprocess), so a user who toggled
      // the mutating tier off should not be exposed to it just because
      // pdv_run's own switch happens to still be on.
      assertMutatingToolsEnabled(ctx);
      assertPdvRunEnabled(ctx);
      requireKernel(ctx);
      const origin: KernelExecutionOrigin = {
        kind: "agent",
        agentTool: "pdv_run",
      };
      const result = await runOnKernel(ctx, code, origin);
      return textResult(formatExecutionSummary(result, ctx, origin));
    },
  );

  // ---------------------------------------------------------------------------
  // cell_list / cell_read / cell_write / cell_run
  // ---------------------------------------------------------------------------
  server.registerTool(
    "cell_list",
    {
      title: "List PDV code cells",
      annotations: { readOnlyHint: true },
      description:
        "List the renderer's code-cell tabs (id, optional name, source " +
        "length). Use `cell_read` to fetch a cell's full source.",
      inputSchema: {},
    },
    async (_args, extra) => {
      assertCurrentGeneration(ctx, extra);
      const listed = await ctx.cellRpc.list();
      if (listed.tabs.length === 0) {
        return textResult("(no code cells)");
      }
      const lines = listed.tabs.map((t) => {
        const name = t.name ? ` "${t.name}"` : "";
        const active = listed.activeTabId === t.id ? "  (active)" : "";
        return `id ${t.id}${name}  [${t.length} chars]${active}`;
      });
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "cell_read",
    {
      title: "Read a PDV code cell",
      annotations: { readOnlyHint: true },
      description:
        "Read the full source of one cell tab by id.",
      inputSchema: {
        tab_id: z.number().int().describe("Cell tab id (see `cell_list`)."),
      },
    },
    async ({ tab_id }, extra) => {
      assertCurrentGeneration(ctx, extra);
      const cell = await ctx.cellRpc.read(tab_id);
      // Record this read for the cell_write read-before-write guard. We key
      // on `cell.id` (the renderer's canonical id) rather than the request
      // arg so an arg of e.g. `-1` mapping to an active tab still arms the
      // guard for the right tab.
      ctx.recordCellRead(extra.sessionId, cell.id, cell.code);
      const header =
        `cell id: ${cell.id}` + (cell.name ? `  (${cell.name})` : "");
      return textResult(`${header}\n\n${cell.code}`);
    },
  );

  server.registerTool(
    "cell_write",
    {
      title: "Write a PDV code cell",
      description:
        "Overwrite a cell tab's source, or append a new tab when `tab_id` " +
        "is omitted or matches no existing tab. The renderer updates its " +
        "live tab state on receipt. When `tab_id` is provided, you must " +
        "call `cell_read` on that tab first, and the cell must not have " +
        "changed since — this prevents clobbering edits the user or another " +
        "agent made while you were reasoning.",
      inputSchema: {
        tab_id: z
          .number()
          .int()
          .optional()
          .describe("Existing tab id; omit to append a new tab."),
        code: z.string().describe("New source code for the cell."),
        name: z.string().optional().describe("Optional tab display name."),
      },
    },
    async ({ tab_id, code, name }, extra) => {
      assertCurrentGeneration(ctx, extra);
      assertMutatingToolsEnabled(ctx);
      if (tab_id !== undefined) {
        // Read-before-write: fetch the current source and compare it to the
        // hash the session captured at cell_read time. Throws if the
        // session never read this tab, or if the cell changed since.
        const current = await ctx.cellRpc.read(tab_id);
        assertCellReadFresh(ctx, extra, current.id, current.code);
        // Promote the write to the new "last seen" state so the session can
        // immediately follow up with another cell_write without re-reading.
        ctx.recordCellRead(extra.sessionId, current.id, code);
      }
      ctx.cellRpc.write({ tabId: tab_id, code, name });
      return textResult(
        tab_id !== undefined
          ? `Wrote ${code.length} chars to cell ${tab_id}`
          : `Appended new cell (${code.length} chars)`,
      );
    },
  );

  server.registerTool(
    "cell_run",
    {
      title: "Run a PDV code cell",
      description:
        "Read a cell tab and run its source in the live kernel. The run is " +
        "tagged `origin: agent` so the console and transcript attribute it " +
        "to the agent.",
      inputSchema: {
        tab_id: z.number().int().describe("Cell tab id to run."),
      },
    },
    async ({ tab_id }, extra) => {
      assertCurrentGeneration(ctx, extra);
      assertMutatingToolsEnabled(ctx);
      requireKernel(ctx);
      const cell = await ctx.cellRpc.read(tab_id);
      const origin: KernelExecutionOrigin = {
        kind: "agent",
        agentTool: "cell_run",
        tabId: cell.id,
        label: cell.name,
      };
      const result = await runOnKernel(ctx, cell.code, origin);
      return textResult(formatExecutionSummary(result, ctx, origin));
    },
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Verify an active kernel and return its id, or throw a clear error. */
function requireKernel(ctx: McpToolContext): string {
  const kernelId = ctx.hooks.getActiveKernelId();
  if (!kernelId || !ctx.kernelManager.getKernel(kernelId)) {
    throw new Error(
      "No active PDV kernel. Open a project in PDV before using this tool.",
    );
  }
  return kernelId;
}

/**
 * Mirror of the lib-reload preflight in the script:run IPC handler — when a
 * tree path is inside a module, ask the kernel to `importlib.reload` the
 * module's lib files so an agent's edit to a lib takes effect on the next
 * script run. Errors are swallowed: a reload failure must not block the run.
 */
async function runLibReloadPreflight(
  ctx: McpToolContext,
  treePath: string,
): Promise<void> {
  const firstDot = treePath.indexOf(".");
  if (firstDot <= 0) return;
  const alias = treePath.slice(0, firstDot);
  try {
    await ctx.commRouter.request(PDVMessageType.MODULE_RELOAD_LIBS, { alias });
  } catch (err) {
    console.warn(`[mcp] reload_libs preflight failed for ${alias}:`, err);
  }
}

/**
 * Build the language-appropriate `pdv_tree[...].run(...)` invocation string.
 * Mirrors the codegen in the `script:run` IPC handler.
 */
function buildScriptInvocation(
  language: "python" | "julia",
  treePath: string,
  params: Record<string, unknown>,
): string {
  const entries = Object.entries(params);
  if (language === "julia") {
    const kwargs = entries
      .map(([k, v]) => formatJuliaKwarg(k, v))
      .join(", ");
    const pathStr = JSON.stringify(treePath);
    return kwargs
      ? `PDVKernel.run_tree_script(pdv_tree, ${pathStr}; ${kwargs})`
      : `PDVKernel.run_tree_script(pdv_tree, ${pathStr})`;
  }
  const kwargs = entries.map(([k, v]) => formatPythonKwarg(k, v)).join(", ");
  return kwargs
    ? `pdv_tree[${JSON.stringify(treePath)}].run(${kwargs})`
    : `pdv_tree[${JSON.stringify(treePath)}].run()`;
}

function formatPythonKwarg(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}=None`;
  if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `${key}=${value ? "True" : "False"}`;
  return `${key}=${String(value)}`;
}

function formatJuliaKwarg(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}=nothing`;
  if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `${key}=${value ? "true" : "false"}`;
  return `${key}=${String(value)}`;
}

/**
 * Execute one code string on the active kernel with the given origin. Every
 * such run is recorded to the §15.7 transcript (via
 * {@link executeAndTranscribe}) AND streams its iopub chunks to the
 * renderer's Console (via `IPC.push.executeOutput`) so agent-initiated runs
 * are visible alongside user-initiated ones (ARCHITECTURE.md §15.9).
 */
async function runOnKernel(
  ctx: McpToolContext,
  code: string,
  origin: KernelExecutionOrigin,
): Promise<KernelExecuteResult> {
  const kernelId = ctx.hooks.getActiveKernelId();
  if (!kernelId) throw new Error("No active kernel for execution.");
  const workingDir = ctx.hooks.getActiveWorkingDir();
  const transcript = workingDir ? new TranscriptWriter(workingDir) : null;
  const win = ctx.getRendererWindow();
  // Generate the executionId up front so we can bracket the run with
  // begin/finish pushes — the renderer needs a seeded log entry before
  // streaming chunks attach to it.
  const executionId = randomUUID();
  const start = Date.now();
  const sendToRenderer = (channel: string, payload: unknown): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };
  sendToRenderer(IPC.push.executeBegin, {
    executionId,
    code,
    origin,
    timestamp: start,
  });
  try {
    const result = await executeAndTranscribe(
      ctx.kernelManager.execute.bind(ctx.kernelManager),
      transcript,
      kernelId,
      { code, executionId, origin },
      (chunk) => sendToRenderer(IPC.push.executeOutput, chunk),
    );
    sendToRenderer(IPC.push.executeFinish, {
      executionId,
      duration: result.duration ?? Date.now() - start,
      error: result.error,
      errorDetails: result.errorDetails,
    });
    return result;
  } catch (err) {
    // A throw can happen far into a long-running execution (kernel timeout,
    // transport error). Report the elapsed wall time so the Console doesn't
    // claim a 30-second failure took 0 ms.
    sendToRenderer(IPC.push.executeFinish, {
      executionId,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Render the structured execution summary an agent gets back from
 * `script_run` / `pdv_run` / `cell_run`. Per §15.7: status, duration, the
 * final lines of output inline (capped), the transcript-file path, and full
 * error + traceback when failure.
 */
function formatExecutionSummary(
  result: KernelExecuteResult,
  ctx: McpToolContext,
  origin: KernelExecutionOrigin,
): string {
  const status = result.error ? "error" : "ok";
  const durationSec =
    typeof result.duration === "number"
      ? (result.duration / 1000).toFixed(2)
      : "?";
  const workingDir = ctx.hooks.getActiveWorkingDir();
  const transcriptPath = workingDir
    ? `${workingDir}/execution-transcript.txt`
    : "(no transcript — working dir unavailable)";
  const lines: string[] = [
    `status: ${status}`,
    `duration: ${durationSec}s`,
    `origin: agent:${origin.agentTool ?? "?"}`,
    `transcript: ${transcriptPath}`,
  ];
  if (result.error) {
    lines.push("", `error: ${result.error}`);
    const tb = result.errorDetails?.traceback;
    if (tb && tb.length > 0) {
      lines.push("", "traceback:", ...tb);
    }
  }
  // Surface the run()'s return value inline. Scripts often write into
  // pdv_tree and return a summary dict; without this, a `script_run`
  // that doesn't print() leaves the agent staring at an empty `output`
  // section even though useful data is in `result.result`.
  if (result.result !== undefined && result.result !== null) {
    lines.push("", `return value: ${formatReturnValue(result.result)}`);
  }
  const stdoutTail = tailLines(result.stdout, SUMMARY_TAIL_LINES);
  const stderrTail = tailLines(result.stderr, SUMMARY_TAIL_LINES);
  if (stdoutTail) {
    lines.push("", `output (last ${SUMMARY_TAIL_LINES} lines):`, stdoutTail);
  }
  if (stderrTail && !result.error) {
    lines.push("", "stderr:", stderrTail);
  }
  return lines.join("\n");
}

/**
 * Render the kernel's return value for the structured summary. Compact JSON
 * when it serializes cleanly; capped so a huge dict doesn't blow context.
 */
function formatReturnValue(value: unknown): string {
  const MAX_LEN = 1200;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length > MAX_LEN) {
    return `${text.slice(0, MAX_LEN)}… (truncated; ${text.length - MAX_LEN} more chars)`;
  }
  return text;
}

/** Return the last `n` lines of `text` (whole string when shorter). */
function tailLines(text: string | undefined, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}
