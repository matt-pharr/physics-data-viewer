/**
 * mcp-agent-coupling.spec.ts — Phase 3 visual-coupling E2E.
 *
 * Drives the MCP server end-to-end and asserts the renderer's visual
 * coupling lands:
 *
 * 1. Launch PDV with the mutating-tool and pdv_run gates flipped on so the
 *    spec can exercise the `pdv_run` tool (the smallest agent-run path).
 * 2. Read the MCP endpoint + bearer token via `window.pdv.mcp.getStatus()`.
 * 3. POST `initialize` over Streamable HTTP — this opens a real MCP
 *    session against the running server (no stub) and triggers the
 *    `mcpClientStatus` push.
 * 4. Assert the StatusBar grows a `[data-testid="mcp-client-indicator"]`
 *    badge — the renderer received the push and `mcpClientAttached` is
 *    `true`.
 * 5. POST `tools/call pdv_run` with a tiny snippet so the main process
 *    runs the kernel execution with `origin.kind === "agent"` and pushes
 *    `executeBegin` / `executeFinish` to seed the Console log entry.
 * 6. Assert a `.log-entry-agent` row appears in the Console, with the
 *    `Agent · pdv_run` source label, end-to-end.
 *
 * Catches regressions in: MCP HTTP auth + session bookkeeping, the
 * `mcpClientStatus` push channel, the renderer's
 * `mcp.onClientStatus` subscription, the `executeBegin`/`executeFinish`
 * bracketing pushes that seed agent log entries, and the agent-styling
 * branch in `Console`.
 */

import { test, expect } from "@playwright/test";
import type { McpStatus, PDVApi } from "../renderer/src/types/pdv";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { createNewPythonProject } from "./helpers/new-project";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchPDV({
    // Mutating + pdv_run tools default off; flip both on so this spec can
    // exercise the smallest agent-run code path.
    preferences: {
      mcp: { mutatingToolsEnabled: true, pdvRunEnabled: true },
    },
  });
  await createNewPythonProject(launched.window);
  await expectKernelReady(launched.window);
});

test.afterAll(async () => {
  await launched?.cleanup();
});

/**
 * Parse the body of a Streamable HTTP response. The transport may return
 * either plain JSON (`content-type: application/json`) or an SSE stream
 * (`text/event-stream`) of `data: <json>` frames. Both shapes carry one
 * JSON-RPC envelope per request, which is what we extract here.
 */
function parseMcpResponse(contentType: string | null, body: string): {
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { message: string };
} {
  if (contentType?.includes("application/json")) {
    return JSON.parse(body);
  }
  // SSE: pull the first `data:` frame.
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice("data: ".length));
    }
  }
  throw new Error(`unparseable MCP response body: ${body.slice(0, 200)}`);
}

test("MCP client initialize → status dot lights → pdv_run → agent-styled console entry", async () => {
  const { window } = launched;

  // (1) Read endpoint + token from the renderer. The MCP server is launched
  // by the main process at app startup, so by the time the kernel is ready
  // these values are stable.
  const status: McpStatus = await window.evaluate(async () => {
    const pdv = (window as unknown as { pdv: PDVApi }).pdv;
    return pdv.mcp.getStatus();
  });
  expect(status.running).toBe(true);
  expect(status.url).toBeTruthy();
  expect(status.token).toBeTruthy();

  // The renderer hasn't seen any client yet, so the indicator is absent.
  await expect(
    window.locator('[data-testid="mcp-client-indicator"]'),
  ).toHaveCount(0);

  // (2) Initialize a real MCP session against the running server.
  const initRes = await fetch(status.url as string, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${status.token as string}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-phase3", version: "0" },
      },
    }),
  });
  expect(initRes.status).toBe(200);
  const sessionId = initRes.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await initRes.text();

  // (3) The push from `onsessioninitialized` should reach the renderer and
  // light the StatusBar indicator.
  await expect(
    window.locator('[data-testid="mcp-client-indicator"]'),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    window.locator('[data-testid="mcp-client-indicator"] .status-dot.mcp-attached'),
  ).toBeVisible();

  // The MCP spec requires the initialized notification before tool calls.
  await fetch(status.url as string, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${status.token as string}`,
      "mcp-session-id": sessionId as string,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  // (4) Drive `pdv_run` through the real tool path.
  const runRes = await fetch(status.url as string, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${status.token as string}`,
      "mcp-session-id": sessionId as string,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "pdv_run",
        arguments: { code: "print('hi from e2e')\n1 + 2\n" },
      },
    }),
  });
  expect(runRes.status).toBe(200);
  const runBody = await runRes.text();
  const runJson = parseMcpResponse(runRes.headers.get("content-type"), runBody);
  expect(runJson.error).toBeUndefined();
  const firstBlock = runJson.result?.content?.[0]?.text ?? "";
  expect(firstBlock).toMatch(/hi from e2e/);

  // (5) The agent-tagged execution should produce a Console entry with the
  // agent modifier class and the `Agent · pdv_run` source label.
  const agentEntry = window.locator(".log-entry.log-entry-agent").last();
  await expect(agentEntry).toBeVisible({ timeout: 15_000 });
  await expect(agentEntry.locator(".log-source")).toHaveText("Agent · pdv_run");
  await expect(agentEntry.locator(".log-stdout")).toContainText("hi from e2e");
});
