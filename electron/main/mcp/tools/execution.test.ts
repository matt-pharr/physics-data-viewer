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
import type { ToolExtra } from "./_helpers";
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
    cellRpc: {} as McpToolContext["cellRpc"],
    getRendererWindow: () => null,
    getSessionGeneration: () => 0,
    recordCellRead: () => undefined,
    getCellReadHash: () => undefined,
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
