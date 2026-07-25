/**
 * ipc-register-config.test.ts — Unit tests for the server-side `config.*`
 * invoke handlers.
 *
 * Drives the real invoke registry. Behavior under test: fresh snapshots on
 * `config:get`, partial-merge semantics + `onConfigChanged` wiring on
 * `config:set`, and the deep-merge of the `mcp` / `launchers` subtrees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PDVConfig } from "./config";
import { IPC } from "./ipc";
import { registerConfigIpcHandlers } from "./ipc-register-config";
import {
  createConfigStoreMock,
  getInvokeHandler,
  resetInvokeRegistry,
} from "./test-helpers";

function makeConfig(): PDVConfig {
  return {
    showPrivateVariables: false,
    showModuleVariables: false,
    showCallableVariables: false,
    autoRefreshNamespace: false,
  };
}

interface Harness {
  config: ReturnType<typeof createConfigStoreMock<PDVConfig>>;
  onConfigChanged: ReturnType<typeof vi.fn>;
}

function setup(): Harness {
  const config = createConfigStoreMock<PDVConfig>(makeConfig());
  const onConfigChanged = vi.fn();
  registerConfigIpcHandlers({
    configStore: config.store,
    onConfigChanged,
  });
  return { config, onConfigChanged };
}

beforeEach(() => {
  resetInvokeRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  resetInvokeRegistry();
  vi.restoreAllMocks();
});

describe("config:get / config:set", () => {
  it("config:get returns a fresh snapshot from the store", async () => {
    const { config } = setup();
    config.state.showPrivateVariables = true;
    const result = await getInvokeHandler(IPC.config.get)({});
    expect(result).toMatchObject({ showPrivateVariables: true });
  });

  it("config:set merges partial updates and triggers onConfigChanged with prev/next", async () => {
    const { onConfigChanged } = setup();
    await getInvokeHandler(IPC.config.set)({}, { autoRefreshNamespace: true });
    expect(onConfigChanged).toHaveBeenCalledTimes(1);
    const [prev, next] = onConfigChanged.mock.calls[0] as [PDVConfig, PDVConfig];
    expect(prev.autoRefreshNamespace).toBe(false);
    expect(next.autoRefreshNamespace).toBe(true);
  });

  it("config:set skips undefined keys and only writes defined ones", async () => {
    const { config } = setup();
    await getInvokeHandler(IPC.config.set)({}, {
      autoRefreshNamespace: true,
      pythonPath: undefined,
    });
    expect(config.set).toHaveBeenCalledWith("autoRefreshNamespace", true);
    expect(config.set).not.toHaveBeenCalledWith("pythonPath", undefined);
  });

  it("config:set deep-merges the `mcp` subtree to preserve main-only fields", async () => {
    // Simulate the main-side bearer-token persistence: the server has
    // written `authToken` into `mcp`, and the renderer later writes a
    // partial `mcp` block (no `authToken`) to flip a toggle. Without the
    // deep-merge, a full replace would silently wipe `authToken` and
    // break every connected agent on the next toggle.
    const { config } = setup();
    (config.state as unknown as Record<string, unknown>).mcp = {
      authToken: "secret-token",
      defaultPort: 7391,
    };

    await getInvokeHandler(IPC.config.set)({}, {
      mcp: { mutatingToolsEnabled: true },
    } as Partial<PDVConfig>);

    expect((config.state as unknown as Record<string, unknown>).mcp).toMatchObject({
      authToken: "secret-token",
      defaultPort: 7391,
      mutatingToolsEnabled: true,
    });
  });

  it("config:set deep-merges the `launchers` subtree to preserve sibling slots", async () => {
    // A partial `launchers` update (just the agent slot) must not wipe the
    // previously-saved `terminal` / `editor` slots.
    const { config } = setup();
    (config.state as unknown as Record<string, unknown>).launchers = {
      terminal: { preset: "alacritty" },
      editor: { fileCommand: "nvim {}" },
    };

    await getInvokeHandler(IPC.config.set)({}, {
      launchers: { agent: { command: "claude" } },
    } as Partial<PDVConfig>);

    expect((config.state as unknown as Record<string, unknown>).launchers).toMatchObject({
      terminal: { preset: "alacritty" },
      editor: { fileCommand: "nvim {}" },
      agent: { command: "claude" },
    });
  });
});
