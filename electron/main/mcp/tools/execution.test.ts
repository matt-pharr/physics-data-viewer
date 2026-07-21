/**
 * tools/execution.test.ts — Unit tests for the execution MCP tools.
 *
 * Focused on the gating contract — pdv_run requires BOTH
 * `mutatingToolsEnabled` AND `pdvRunEnabled` — and the kwarg formatting
 * helpers' handling of None / null. The full script_run / cell_run paths
 * exercise the live kernel and are covered by the smoke-test sweep.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import type { McpToolContext } from "../mcp-context";
import { hashCellCode, type ToolExtra } from "./_helpers";
import { registerExecutionTools } from "./execution";

type ToolCallback = (
  args: Record<string, unknown>,
  extra: ToolExtra,
) => Promise<CallToolResult>;

function captureTools(): { server: McpServer; tools: Map<string, ToolCallback> } {
  const tools = new Map<string, ToolCallback>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: ToolCallback) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, tools };
}

interface CtxOpts {
  mutatingEnabled?: boolean;
  pdvRunEnabled?: boolean;
  /** When set, `cellRpc.read` rejects with this error message. */
  cellReadError?: string;
  /** When set, used as the response from `cellRpc.read`. */
  cellReadResult?: { id: number; name?: string; code: string };
  /** Captures cell_write fire-and-forget pushes for assertions. */
  cellWriteSpy?: ReturnType<typeof vi.fn>;
  /** Hash recorded for the read-before-write guard, keyed by tab id. */
  cellReadHashes?: Map<number, string>;
}

function makeCtx(opts: CtxOpts = {}): McpToolContext {
  return {
    kernelManager: {
      getKernel: () => ({ id: "k1", language: "python" }),
      execute: vi.fn(async () => ({ stdout: "", duration: 0 })),
    } as unknown as McpToolContext["kernelManager"],
    commRouter: { request: vi.fn() } as unknown as McpToolContext["commRouter"],
    queryRouter: {
      isAttached: () => false,
      request: vi.fn(),
    } as unknown as McpToolContext["queryRouter"],
    projectManager: {} as McpToolContext["projectManager"],
    configStore: {
      get: (key: string) =>
        key === "mcp"
          ? {
              mutatingToolsEnabled: opts.mutatingEnabled ?? false,
              pdvRunEnabled: opts.pdvRunEnabled ?? false,
            }
          : undefined,
    } as unknown as McpToolContext["configStore"],
    hooks: {
      getActiveKernelId: () => "k1",
      getActiveProjectDir: () => "/proj",
      getActiveWorkingDir: () => null,
      getGeneration: () => 0,
      bumpGeneration: () => undefined,
      treeCreate: {
        script: vi.fn(),
        note: vi.fn(),
        lib: vi.fn(),
      },
    } as unknown as McpToolContext["hooks"],
    appVersion: "0.0.0-test",
    cellRpc: {
      read: vi.fn(async (_tabId: number) => {
        if (opts.cellReadError) {
          throw new Error(opts.cellReadError);
        }
        return opts.cellReadResult ?? { id: 1, code: "" };
      }),
      write: opts.cellWriteSpy ?? vi.fn(),
      list: vi.fn(),
    } as unknown as McpToolContext["cellRpc"],
    getRendererWindow: () => null,
    getSessionGeneration: () => 0,
    recordCellRead: vi.fn((_sessionId, tabId, code) => {
      opts.cellReadHashes?.set(tabId, hashCellCode(code));
    }),
    getCellReadHash: (_sessionId, tabId) =>
      opts.cellReadHashes?.get(tabId),
  };
}

const extra = { sessionId: "s1" } as ToolExtra;

describe("pdv_run gating", () => {
  it("requires BOTH `mutatingToolsEnabled` AND `pdvRunEnabled`", async () => {
    // Only pdvRunEnabled — mutating off. Should still refuse.
    const { server, tools } = captureTools();
    registerExecutionTools(
      server,
      makeCtx({ mutatingEnabled: false, pdvRunEnabled: true }),
    );
    await expect(
      tools.get("pdv_run")!({ code: "print(1)" }, extra),
    ).rejects.toThrow(/Mutating MCP tools are disabled/);
  });

  it("refuses when only the mutating-tier is on but pdv_run is off", async () => {
    const { server, tools } = captureTools();
    registerExecutionTools(
      server,
      makeCtx({ mutatingEnabled: true, pdvRunEnabled: false }),
    );
    await expect(
      tools.get("pdv_run")!({ code: "print(1)" }, extra),
    ).rejects.toThrow(/pdv_run.*disabled/i);
  });

  it("script_run requires only the mutating-tier toggle (no pdvRunEnabled)", async () => {
    // Mutating on, pdv_run off — script_run should still be reachable.
    // We can't run end-to-end without a kernel, but the gate check must
    // not raise the pdv_run-specific error message.
    const { server, tools } = captureTools();
    registerExecutionTools(
      server,
      makeCtx({ mutatingEnabled: true, pdvRunEnabled: false }),
    );
    // script_run will reach the script-invocation codegen path and call
    // executeAndTranscribe with the stubbed kernelManager.execute — we
    // only care that it does NOT throw a gating error.
    await expect(
      tools.get("script_run")!(
        { tree_path: "scripts.fit", params: {} },
        extra,
      ),
    ).resolves.toBeDefined();
  });
});

describe("Julia script_run codegen escaping (second review)", () => {
  it("builds run_tree_script with $-escaped path and string params", async () => {
    // The IPC script:run handler was fixed to use juliaStringLiteral in
    // review M4; this MCP mirror was missed by the first fix pass — a bare
    // JSON.stringify lets `$` interpolate inside Julia strings.
    const { server, tools } = captureTools();
    // Typed args so `.mock.calls` carries the request tuple (execute is
    // called as `execute(kernelId, { code })`).
    const executeSpy = vi.fn(
      async (_kernelId: string, _request: { code: string }) => ({
        stdout: "",
        duration: 0,
      }),
    );
    const ctx = makeCtx({ mutatingEnabled: true });
    (ctx.kernelManager as { getKernel: unknown }).getKernel = () => ({
      id: "k1",
      language: "julia",
    });
    (ctx.kernelManager as { execute: unknown }).execute = executeSpy;
    registerExecutionTools(server, ctx);

    await tools.get("script_run")!(
      { tree_path: "scripts.fit", params: { label: "$\\alpha$ scan" } },
      extra,
    );

    expect(executeSpy).toHaveBeenCalled();
    const code = executeSpy.mock.calls.at(-1)![1].code;
    expect(code).toContain("PDVKernel.run_tree_script(pdv_tree, \"scripts.fit\";");
    // `$\alpha$ scan` must arrive with every $ escaped for Julia.
    expect(code).toContain('label="\\$\\\\alpha\\$ scan"');
  });
});

describe("cell_write tab_id contract", () => {
  it("rejects with a clean error when tab_id refers to no existing tab", async () => {
    // The renderer rejects unknown ids with `No cell tab with id N`. The
    // tool layer must convert that into a tool-level error that explains
    // the contract (use cell_list to find ids, omit tab_id to append) —
    // not surface the bare RPC failure.
    const { server, tools } = captureTools();
    const cellWriteSpy = vi.fn();
    registerExecutionTools(
      server,
      makeCtx({
        mutatingEnabled: true,
        cellReadError: "No cell tab with id 99",
        cellWriteSpy,
      }),
    );
    await expect(
      tools.get("cell_write")!(
        { tab_id: 99, code: "x = 1" },
        extra,
      ),
    ).rejects.toThrow(/no cell tab with id 99.*omit tab_id to append/i);
    // The fire-and-forget write must NOT have been issued — the previous
    // behavior was an accidental append on a typo'd tab_id.
    expect(cellWriteSpy).not.toHaveBeenCalled();
  });

  it("re-throws unrelated RPC failures untouched", async () => {
    // Renderer-unreachable / timeout errors should bubble up as-is so the
    // agent can distinguish "you typed the wrong id" from "PDV is gone."
    const { server, tools } = captureTools();
    registerExecutionTools(
      server,
      makeCtx({
        mutatingEnabled: true,
        cellReadError: "Cell read failed: no renderer window",
      }),
    );
    await expect(
      tools.get("cell_write")!(
        { tab_id: 1, code: "x = 1" },
        extra,
      ),
    ).rejects.toThrow(/no renderer window/);
  });

  it("appends without any prior read when tab_id is omitted", async () => {
    // The guard only fires on overwrites of an existing tab_id. An append
    // is safe by definition — there's nothing to clobber.
    const { server, tools } = captureTools();
    const cellWriteSpy = vi.fn();
    registerExecutionTools(
      server,
      makeCtx({
        mutatingEnabled: true,
        cellWriteSpy,
      }),
    );
    await expect(
      tools.get("cell_write")!({ code: "x = 1" }, extra),
    ).resolves.toBeDefined();
    expect(cellWriteSpy).toHaveBeenCalledWith({
      tabId: undefined,
      code: "x = 1",
      name: undefined,
    });
  });
});
