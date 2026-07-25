/**
 * config-bridge.test.ts — Merge and fan-out tests for `config:get` / `config:set`.
 *
 * Drives the real ipcMain handlers (through the mocked registry) against a
 * real {@link LocalConfigStore} and a stub server, so the renderer-visible
 * contract — one flat config in, one flat config out — is asserted end to
 * end rather than at the seams.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcRegistry = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  return {
    handlers,
    ipcHandle: vi.fn(
      (
        channel: string,
        handler: (event: unknown, ...args: unknown[]) => unknown,
      ) => {
        handlers.set(channel, handler);
      },
    ),
    ipcRemoveHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));

import type { PDVConfig } from "../config";
import { INTERNAL_CHANNELS, IPC } from "../ipc";
import { registerConfigBridge } from "./config-bridge";
import { LocalConfigStore } from "./local-config-store";
import type { ServerHandle } from "./server-supervisor";

const dirs: string[] = [];

/** A server whose config half is a plain object, recording what it is sent. */
function makeServer(initial: Partial<PDVConfig> = {}): {
  handle: ServerHandle;
  state: Partial<PDVConfig>;
  sets: Array<Partial<PDVConfig>>;
} {
  const state: Partial<PDVConfig> = { ...initial };
  const sets: Array<Partial<PDVConfig>> = [];
  const handle = {
    kind: "local" as const,
    start: async () => undefined,
    shutdown: async () => undefined,
    sessionReset: async () => undefined,
    setBridgeHandlers: () => undefined,
    clearBridgeHandlers: () => undefined,
    invoke: async (channel: string, args: unknown[] = []) => {
      if (channel === INTERNAL_CHANNELS.serverConfigGet) return { ...state };
      if (channel === INTERNAL_CHANNELS.serverConfigSet) {
        const updates = (args[0] ?? {}) as Partial<PDVConfig>;
        sets.push(updates);
        Object.assign(state, updates);
        return { ...state };
      }
      throw new Error(`unexpected channel ${channel}`);
    },
  } as unknown as ServerHandle;
  return { handle, state, sets };
}

function setup(initial: Partial<PDVConfig> = {}): {
  get: () => Promise<PDVConfig>;
  set: (updates: Partial<PDVConfig>) => Promise<PDVConfig>;
  local: LocalConfigStore;
  sets: Array<Partial<PDVConfig>>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-config-bridge-"));
  dirs.push(dir);
  const local = new LocalConfigStore(dir);
  const server = makeServer(initial);
  registerConfigBridge({ server: server.handle, localConfig: local });

  const call = async (
    channel: string,
    ...args: unknown[]
  ): Promise<PDVConfig> => {
    const handler = ipcRegistry.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return (await handler({}, ...args)) as PDVConfig;
  };

  return {
    get: () => call(IPC.config.get),
    set: (updates) => call(IPC.config.set, updates),
    local,
    sets: server.sets,
  };
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("registerConfigBridge", () => {
  it("registers config:* on ipcMain, not on the server bridge", () => {
    setup();
    expect([...ipcRegistry.handlers.keys()].sort()).toEqual(
      [IPC.config.get, IPC.config.set].sort(),
    );
  });

  it("returns one flat config merged from both halves", async () => {
    const bridge = setup({ pythonPath: "/usr/bin/python3" });
    bridge.local.apply({ theme: "dark" });

    expect(await bridge.get()).toMatchObject({
      pythonPath: "/usr/bin/python3",
      theme: "dark",
    });
  });

  it("lets the local half win over a stale copy left in the server file", async () => {
    // Pre-split installs still carry these keys server-side; they are
    // shadowed rather than deleted, so precedence has to be right.
    const bridge = setup({ theme: "light" } as Partial<PDVConfig>);
    bridge.local.apply({ theme: "dark" });

    expect((await bridge.get()).theme).toBe("dark");
  });

  it("routes each half of a mixed patch to its owner", async () => {
    const bridge = setup();

    const merged = await bridge.set({
      theme: "dark",
      pythonPath: "/opt/py",
    });

    expect(bridge.sets).toEqual([{ pythonPath: "/opt/py" }]);
    expect(bridge.local.getAll().theme).toBe("dark");
    expect(merged).toMatchObject({ theme: "dark", pythonPath: "/opt/py" });
  });

  it("never forwards a shell-owned key to the server", async () => {
    const bridge = setup();

    await bridge.set({ launchers: { editor: { fileCommand: "vim {}" } } });

    expect(bridge.sets).toEqual([{}]);
  });

  it("still answers with the server half when only local keys changed", async () => {
    const bridge = setup({ pythonPath: "/usr/bin/python3" });

    const merged = await bridge.set({ theme: "light" });

    expect(merged.pythonPath).toBe("/usr/bin/python3");
  });

  it("persists local writes so a later get sees them", async () => {
    const bridge = setup();

    await bridge.set({ settings: { shortcuts: { save: "Cmd+S" } } });

    expect((await bridge.get()).settings).toEqual({
      shortcuts: { save: "Cmd+S" },
    });
  });
});
