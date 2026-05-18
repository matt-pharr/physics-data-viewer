/**
 * tools/tree-read.test.ts — Tests for the read-only Tree MCP tools.
 *
 * The tools are registered on a fake `McpServer` that captures each tool's
 * callback, so the callbacks can be invoked directly against a mocked
 * kernel-query context.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { PDVMessage } from "../../pdv-protocol";
import type { McpToolContext } from "../mcp-context";
import type { ToolExtra } from "./_helpers";
import { registerTreeReadTools } from "./tree-read";

/** A captured tool callback. */
type ToolCallback = (
  args: Record<string, unknown>,
  extra: ToolExtra,
) => Promise<CallToolResult>;

/** A kernel-query stub: maps a message type to a response payload. */
type QueryFn = (type: string, payload: Record<string, unknown>) => Promise<PDVMessage>;

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

/** Wrap a payload as an `ok` PDV response message. */
function okMessage(payload: Record<string, unknown>): PDVMessage {
  return {
    pdv_version: "0",
    msg_id: "m",
    in_reply_to: "r",
    type: "x.response",
    status: "ok",
    payload,
  };
}

/** Build a tool context whose kernel queries are served by `query`. */
function makeCtx(query: QueryFn, kernelRunning = true): McpToolContext {
  return {
    kernelManager: {
      getKernel: () => (kernelRunning ? { id: "k1" } : undefined),
    } as unknown as McpToolContext["kernelManager"],
    commRouter: { request: query } as unknown as McpToolContext["commRouter"],
    queryRouter: {
      isAttached: () => true,
      request: query,
    } as unknown as McpToolContext["queryRouter"],
    projectManager: {} as McpToolContext["projectManager"],
    configStore: {} as McpToolContext["configStore"],
    hooks: {
      getActiveKernelId: () => "k1",
      getActiveProjectDir: () => "/proj",
      getGeneration: () => 0,
      bumpGeneration: () => undefined,
    },
    appVersion: "0.0.0-test",
    getSessionGeneration: () => 0,
  };
}

/** Extract the text content of a tool result. */
function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block.type === "text" ? block.text : "";
}

const extra = { sessionId: "s1" } as ToolExtra;

describe("tree-read tools", () => {
  it("tree_list formats the child nodes at a path", async () => {
    const { server, tools } = captureTools();
    const ctx = makeCtx(async () =>
      okMessage({
        nodes: [
          { key: "data", type: "folder", has_children: true },
          { key: "fit", type: "ndarray", has_children: false, preview: "float64 (1024,)" },
        ],
      }),
    );
    registerTreeReadTools(server, ctx);

    const result = await tools.get("tree_list")!({ path: "" }, extra);
    const text = textOf(result);
    expect(text).toContain("data");
    expect(text).toContain("has children");
    expect(text).toContain("float64 (1024,)");
  });

  it("tree_get_node includes the on-disk path for a file-backed node", async () => {
    const { server, tools } = captureTools();
    const query = vi.fn<QueryFn>(async (type: string) => {
      if (type === "pdv.tree.get") {
        return okMessage({ type: "script", python_type: "PDVScript" });
      }
      if (type === "pdv.tree.resolve_file") {
        return okMessage({ file_path: "/proj/tree/abc123/run.py" });
      }
      return okMessage({});
    });
    const ctx = makeCtx(query);
    registerTreeReadTools(server, ctx);

    const result = await tools.get("tree_get_node")!({ path: "scripts.run" }, extra);
    expect(textOf(result)).toContain("/proj/tree/abc123/run.py");
  });

  it("tree_get_data caps an oversized payload", async () => {
    const { server, tools } = captureTools();
    const big = "x".repeat(20000);
    const ctx = makeCtx(async () => okMessage({ type: "text", value: big }));
    registerTreeReadTools(server, ctx);

    const result = await tools.get("tree_get_data")!({ path: "notes.big" }, extra);
    const text = textOf(result);
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(big.length);
  });

  it("rejects a tool call when no kernel is running", async () => {
    const { server, tools } = captureTools();
    const ctx = makeCtx(async () => okMessage({}), false);
    registerTreeReadTools(server, ctx);

    await expect(tools.get("tree_list")!({ path: "" }, extra)).rejects.toThrow(
      /no active pdv kernel/i,
    );
  });
});
