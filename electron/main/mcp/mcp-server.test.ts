/**
 * mcp-server.test.ts — Lifecycle, port-fallback, and auth tests for the
 * PDV MCP server, plus the generation-staleness guard.
 */

import * as http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

const ipcRegistry = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: ipcRegistry.handle, removeHandler: ipcRegistry.removeHandler },
}));

import type { McpToolContext, McpServerHooks } from "./mcp-context";
import { PdvMcpServer, type PdvMcpServerDeps } from "./mcp-server";
import { assertCurrentGeneration, type ToolExtra } from "./tools/_helpers";

/** Build stub lifecycle hooks fixed at a given generation. */
function makeHooks(generation = 0): McpServerHooks {
  return {
    getActiveKernelId: () => null,
    getActiveProjectDir: () => null,
    getActiveWorkingDir: () => null,
    getGeneration: () => generation,
    bumpGeneration: () => undefined,
    treeCreate: {
      script: () => Promise.reject(new Error("not implemented in tests")),
      note: () => Promise.reject(new Error("not implemented in tests")),
      lib: () => Promise.reject(new Error("not implemented in tests")),
    },
  };
}

/**
 * Build a minimal in-memory `ConfigStore` stub backed by `state`, so the
 * server's first-run token write (`mcp.authToken`) round-trips like the real
 * store does.
 */
function makeConfigStore(
  state: Record<string, unknown>,
): PdvMcpServerDeps["configStore"] {
  return {
    get: (key: string) => state[key],
    set: (key: string, value: unknown) => {
      state[key] = value;
    },
  } as unknown as PdvMcpServerDeps["configStore"];
}

/** Build server deps whose config reports `port` as the preferred MCP port. */
function makeDeps(
  port: number,
  configStore: PdvMcpServerDeps["configStore"] = makeConfigStore({
    mcp: { defaultPort: port },
  }),
): PdvMcpServerDeps {
  return {
    kernelManager: {} as PdvMcpServerDeps["kernelManager"],
    commRouter: {} as PdvMcpServerDeps["commRouter"],
    queryRouter: {} as PdvMcpServerDeps["queryRouter"],
    projectManager: {} as PdvMcpServerDeps["projectManager"],
    configStore,
    hooks: makeHooks(),
    appVersion: "0.0.0-test",
    cellRpc: {} as PdvMcpServerDeps["cellRpc"],
    getRendererWindow: () => null,
  };
}

/**
 * A random high port. Tests that do not exercise the port-fallback path
 * should pass `0` to {@link makeDeps} instead — the OS then picks a free
 * port directly, removing collision risk across parallel test files.
 */
function randomPort(): number {
  return 48000 + Math.floor(Math.random() * 1500);
}

describe("PdvMcpServer", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("starts and stops, reporting status", async () => {
    const server = new PdvMcpServer(makeDeps(0));
    cleanup.push(() => server.stop());
    expect(server.status.running).toBe(false);

    await server.start();
    const status = server.status;
    expect(status.running).toBe(true);
    expect(typeof status.port).toBe("number");
    expect(status.token).toBeTruthy();
    expect(status.url).toBe(`http://127.0.0.1:${status.port}/mcp`);

    await server.stop();
    expect(server.status.running).toBe(false);
  });

  it("falls back to the next port when the preferred port is taken", async () => {
    const preferred = randomPort();
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(preferred, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((r) => blocker.close(() => r())));

    const server = new PdvMcpServer(makeDeps(preferred));
    cleanup.push(() => server.stop());
    await server.start();
    expect(server.status.port).toBeGreaterThan(preferred);
  });

  it("rejects requests without the bearer token", async () => {
    const server = new PdvMcpServer(makeDeps(0));
    cleanup.push(() => server.stop());
    await server.start();

    const res = await fetch(server.status.url as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    await res.text();
    expect(res.status).toBe(401);
  });

  it("accepts an initialize request carrying the bearer token", async () => {
    const server = new PdvMcpServer(makeDeps(0));
    cleanup.push(() => server.stop());
    await server.start();

    const res = await fetch(server.status.url as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${server.status.token as string}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("serverInfo");
  });

  it("persists its bearer token across server instances", async () => {
    const state: Record<string, unknown> = { mcp: { defaultPort: 0 } };
    const configStore = makeConfigStore(state);

    // First instance mints a token and writes it to the config store.
    const first = new PdvMcpServer(makeDeps(0, configStore));
    cleanup.push(() => first.stop());
    await first.start();
    const token = first.status.token as string;
    expect(token).toBeTruthy();
    expect((state.mcp as { authToken?: string }).authToken).toBe(token);
    await first.stop();

    // A relaunch builds a fresh server against the same persisted config and
    // reuses the stored token instead of rotating it. The port the OS picks
    // may differ — token reuse is what's being asserted.
    const second = new PdvMcpServer(makeDeps(0, configStore));
    cleanup.push(() => second.stop());
    await second.start();
    expect(second.status.token).toBe(token);
  });
});

describe("assertCurrentGeneration", () => {
  function ctxWith(currentGen: number, sessionGen: number | undefined): McpToolContext {
    return {
      kernelManager: {} as McpToolContext["kernelManager"],
      commRouter: {} as McpToolContext["commRouter"],
      queryRouter: {} as McpToolContext["queryRouter"],
      projectManager: {} as McpToolContext["projectManager"],
      configStore: {} as McpToolContext["configStore"],
      hooks: makeHooks(currentGen),
      appVersion: "0.0.0-test",
      cellRpc: {} as McpToolContext["cellRpc"],
      getRendererWindow: () => null,
      getSessionGeneration: () => sessionGen,
    };
  }
  const extra = { sessionId: "s1" } as ToolExtra;

  it("passes when the session generation matches", () => {
    expect(() => assertCurrentGeneration(ctxWith(3, 3), extra)).not.toThrow();
  });

  it("throws when the project/kernel changed since the session connected", () => {
    expect(() => assertCurrentGeneration(ctxWith(4, 3), extra)).toThrow(/reconnect/i);
  });

  it("passes for an unknown session (no recorded generation)", () => {
    expect(() => assertCurrentGeneration(ctxWith(4, undefined), extra)).not.toThrow();
  });
});
