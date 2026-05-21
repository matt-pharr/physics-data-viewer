/**
 * tools/tree-mutate.test.ts — Unit tests for the mutating Tree MCP tools.
 *
 * Verifies the dispatch shape of `create_tree_node`, the
 * mutating-tools-enabled gate, the rename-vs-move branching of
 * `move_tree_node`, and the native delete-confirmation round-trip of
 * `delete_tree_node` (with `electron.dialog` stubbed).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialogMock = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}));

vi.mock("electron", () => ({
  dialog: dialogMock,
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import type { McpToolContext } from "../mcp-context";
import type { ToolExtra } from "./_helpers";
import { registerTreeMutateTools } from "./tree-mutate";

/** A captured tool callback. */
type ToolCallback = (
  args: Record<string, unknown>,
  extra: ToolExtra,
) => Promise<CallToolResult>;

/** Build a fake McpServer that captures registered tool callbacks. */
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
  /** Whether `mcp.mutatingToolsEnabled` is on (default: true). */
  mutatingEnabled?: boolean;
  /** Whether `mcp.pdvRunEnabled` is on (default: false). */
  pdvRunEnabled?: boolean;
  /** Active kernel id (default: "k1"; pass null to simulate no kernel). */
  activeKernelId?: string | null;
  /** Override the kernelMutate transport (defaults to a vi.fn that returns ok). */
  commRequest?: (
    type: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Override treeCreate.script (defaults to a vi.fn returning success). */
  treeCreateScript?: McpToolContext["hooks"]["treeCreate"]["script"];
  /** Override treeCreate.note. */
  treeCreateNote?: McpToolContext["hooks"]["treeCreate"]["note"];
  /** Override treeCreate.lib. */
  treeCreateLib?: McpToolContext["hooks"]["treeCreate"]["lib"];
}

function makeCtx(opts: CtxOpts = {}): {
  ctx: McpToolContext;
  commRequest: ReturnType<typeof vi.fn>;
} {
  const commRequest = vi.fn(
    opts.commRequest
      ? opts.commRequest
      : async (type: string, _payload: Record<string, unknown>) => ({
          pdv_version: "0",
          msg_id: "m",
          in_reply_to: "r",
          type: `${type}.response`,
          status: "ok",
          payload: {},
        }),
  );
  const activeKernelId =
    opts.activeKernelId === undefined ? "k1" : opts.activeKernelId;
  const ctx = {
    kernelManager: {
      getKernel: () => (activeKernelId ? { id: activeKernelId } : undefined),
    } as unknown as McpToolContext["kernelManager"],
    commRouter: {
      request: commRequest,
    } as unknown as McpToolContext["commRouter"],
    queryRouter: {
      isAttached: () => false,
      request: vi.fn(),
    } as unknown as McpToolContext["queryRouter"],
    projectManager: {} as McpToolContext["projectManager"],
    configStore: {
      get: (key: string) =>
        key === "mcp"
          ? {
              mutatingToolsEnabled: opts.mutatingEnabled ?? true,
              pdvRunEnabled: opts.pdvRunEnabled ?? false,
            }
          : undefined,
    } as unknown as McpToolContext["configStore"],
    hooks: {
      getActiveKernelId: () => activeKernelId,
      getActiveProjectDir: () => "/proj",
      getActiveWorkingDir: () => "/tmp/wd-test",
      getGeneration: () => 0,
      bumpGeneration: () => undefined,
      treeCreate: {
        script:
          opts.treeCreateScript ??
          (vi.fn(async () => ({
            success: true,
            scriptPath: "/tmp/wd-test/tree/uuid1/fit.py",
            treePath: "analysis.fit",
          })) as McpToolContext["hooks"]["treeCreate"]["script"]),
        note:
          opts.treeCreateNote ??
          (vi.fn(async () => ({
            success: true,
            notePath: "/tmp/wd-test/tree/uuid2/readme.md",
            treePath: "analysis.readme",
          })) as McpToolContext["hooks"]["treeCreate"]["note"]),
        lib:
          opts.treeCreateLib ??
          (vi.fn(async () => ({
            success: true,
            libPath: "/tmp/wd-test/tree/uuid3/helpers.py",
            treePath: "analysis.helpers",
          })) as McpToolContext["hooks"]["treeCreate"]["lib"]),
      },
    },
    appVersion: "0.0.0-test",
    cellRpc: {} as McpToolContext["cellRpc"],
    getRendererWindow: () => null,
    getSessionGeneration: () => 0,
    recordCellRead: () => undefined,
    getCellReadHash: () => undefined,
  };
  return { ctx, commRequest };
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block.type === "text" ? block.text : "";
}

const extra = { sessionId: "s1" } as ToolExtra;

beforeEach(() => {
  dialogMock.showMessageBox.mockReset();
});

describe("create_tree_node", () => {
  it("type='dict' issues TREE_CREATE_NODE with parent_path + name", async () => {
    const { server, tools } = captureTools();
    const { ctx, commRequest } = makeCtx();
    registerTreeMutateTools(server, ctx);
    commRequest.mockResolvedValueOnce({
      payload: { path: "analysis.equilibrium" },
    });

    const result = await tools.get("create_tree_node")!(
      { type: "dict", parent_path: "analysis", name: "equilibrium" },
      extra,
    );

    expect(commRequest).toHaveBeenCalledWith("pdv.tree.create_node", {
      parent_path: "analysis",
      name: "equilibrium",
    });
    expect(textOf(result)).toContain("Created dict node at analysis.equilibrium");
  });

  it("type='script' delegates to hooks.treeCreate.script and inlines the stub", async () => {
    // Stage a real stub file on disk so the response includes its contents.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-mutate-test-"));
    const stubPath = path.join(dir, "fit.py");
    await fs.writeFile(stubPath, "def run(pdv_tree, **kw):\n    return {}\n");

    const scriptStub = vi.fn(async () => ({
      success: true,
      scriptPath: stubPath,
      treePath: "analysis.fit",
    })) as McpToolContext["hooks"]["treeCreate"]["script"];
    const { server, tools } = captureTools();
    const { ctx } = makeCtx({ treeCreateScript: scriptStub });
    registerTreeMutateTools(server, ctx);

    const result = await tools.get("create_tree_node")!(
      { type: "script", parent_path: "analysis", name: "fit" },
      extra,
    );

    expect(scriptStub).toHaveBeenCalledWith("k1", "analysis", "fit");
    const text = textOf(result);
    expect(text).toContain("Created script");
    expect(text).toContain("analysis.fit");
    expect(text).toContain("current stub:\ndef run(pdv_tree, **kw):");
    expect(text).toContain("Read this file before Write");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("type='note' delegates to hooks.treeCreate.note", async () => {
    const { server, tools } = captureTools();
    const { ctx } = makeCtx();
    registerTreeMutateTools(server, ctx);

    const result = await tools.get("create_tree_node")!(
      { type: "note", parent_path: "analysis", name: "readme" },
      extra,
    );
    const text = textOf(result);
    expect(text).toContain("Created note");
    expect(text).toContain("analysis.readme");
    expect(text).toContain("current contents: (empty)");
    expect(text).toContain("Read this file before Write");
  });

  it("type='lib' delegates to hooks.treeCreate.lib", async () => {
    const { server, tools } = captureTools();
    const { ctx } = makeCtx();
    registerTreeMutateTools(server, ctx);

    const result = await tools.get("create_tree_node")!(
      { type: "lib", parent_path: "analysis", name: "helpers" },
      extra,
    );
    const text = textOf(result);
    expect(text).toContain("Created lib");
    expect(text).toContain("analysis.helpers");
    expect(text).toContain("Read this file before Write");
  });

  it("throws when mutating tools are disabled", async () => {
    const { server, tools } = captureTools();
    const { ctx } = makeCtx({ mutatingEnabled: false });
    registerTreeMutateTools(server, ctx);

    await expect(
      tools.get("create_tree_node")!(
        { type: "dict", parent_path: "", name: "x" },
        extra,
      ),
    ).rejects.toThrow(/Mutating MCP tools are disabled/);
  });

  it("throws when no kernel is active", async () => {
    const { server, tools } = captureTools();
    const { ctx } = makeCtx({ activeKernelId: null });
    registerTreeMutateTools(server, ctx);

    await expect(
      tools.get("create_tree_node")!(
        { type: "dict", parent_path: "", name: "x" },
        extra,
      ),
    ).rejects.toThrow(/No active PDV kernel/);
  });

  it("rejects an empty `name`", async () => {
    const { server, tools } = captureTools();
    const { ctx } = makeCtx();
    registerTreeMutateTools(server, ctx);
    await expect(
      tools.get("create_tree_node")!(
        { type: "dict", parent_path: "", name: "   " },
        extra,
      ),
    ).rejects.toThrow(/non-empty string/);
  });
});

describe("delete_tree_node", () => {
  it("does NOT send TREE_DELETE when the user cancels the dialog", async () => {
    dialogMock.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const { server, tools } = captureTools();
    const { ctx, commRequest } = makeCtx();
    registerTreeMutateTools(server, ctx);

    await expect(
      tools.get("delete_tree_node")!({ path: "analysis.draft" }, extra),
    ).rejects.toThrow(/User refused/);
    expect(commRequest).not.toHaveBeenCalled();
  });

  it("sends TREE_DELETE only when the user clicks Delete", async () => {
    dialogMock.showMessageBox.mockResolvedValueOnce({ response: 1 });
    const { server, tools } = captureTools();
    const { ctx, commRequest } = makeCtx();
    registerTreeMutateTools(server, ctx);

    const result = await tools.get("delete_tree_node")!(
      { path: "analysis.draft" },
      extra,
    );
    expect(commRequest).toHaveBeenCalledWith("pdv.tree.delete", {
      path: "analysis.draft",
    });
    expect(textOf(result)).toContain("Deleted analysis.draft");
  });

  it("is gated by the mutating-tools toggle", async () => {
    const { server, tools } = captureTools();
    const { ctx, commRequest } = makeCtx({ mutatingEnabled: false });
    registerTreeMutateTools(server, ctx);

    await expect(
      tools.get("delete_tree_node")!({ path: "analysis.draft" }, extra),
    ).rejects.toThrow(/Mutating MCP tools are disabled/);
    expect(commRequest).not.toHaveBeenCalled();
    expect(dialogMock.showMessageBox).not.toHaveBeenCalled();
  });
});

describe("move_tree_node", () => {
  let cleanups: Array<() => Promise<void>>;
  beforeEach(() => {
    cleanups = [];
  });
  afterEach(async () => {
    for (const fn of cleanups) await fn();
  });

  it("emits TREE_RENAME when the parent path is unchanged", async () => {
    const { server, tools } = captureTools();
    const { ctx, commRequest } = makeCtx();
    registerTreeMutateTools(server, ctx);

    const result = await tools.get("move_tree_node")!(
      { from_path: "analysis.draft", to_path: "analysis.final" },
      extra,
    );
    expect(commRequest).toHaveBeenCalledWith("pdv.tree.rename", {
      path: "analysis.draft",
      new_name: "final",
    });
    expect(textOf(result)).toContain("Renamed analysis.draft → analysis.final");
  });

  it("emits TREE_MOVE when the parent path changes", async () => {
    const { server, tools } = captureTools();
    const { ctx, commRequest } = makeCtx();
    registerTreeMutateTools(server, ctx);

    const result = await tools.get("move_tree_node")!(
      { from_path: "scratch.draft", to_path: "analysis.final" },
      extra,
    );
    expect(commRequest).toHaveBeenCalledWith("pdv.tree.move", {
      path: "scratch.draft",
      new_path: "analysis.final",
    });
    expect(textOf(result)).toContain("Moved scratch.draft → analysis.final");
  });

  it("is gated by the mutating-tools toggle", async () => {
    const { server, tools } = captureTools();
    const { ctx, commRequest } = makeCtx({ mutatingEnabled: false });
    registerTreeMutateTools(server, ctx);

    await expect(
      tools.get("move_tree_node")!(
        { from_path: "a.b", to_path: "a.c" },
        extra,
      ),
    ).rejects.toThrow(/Mutating MCP tools are disabled/);
    expect(commRequest).not.toHaveBeenCalled();
  });
});
