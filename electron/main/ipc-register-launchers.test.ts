/**
 * ipc-register-launchers.test.ts — Unit tests for the launcher IPC handlers.
 *
 * Focuses on `launchers.openWorkingDir` (the kernel guard + the
 * dirCommand → spawn path). The agent-launch spec building is covered by
 * `agent-launcher.test.ts`; channel registration is covered by
 * `ipc-register-coverage.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcRegistry = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcHandle = vi.fn(
    (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  );
  return { handlers, ipcHandle };
});

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: ipcRegistry.ipcHandle, removeHandler: vi.fn() },
}));
vi.mock("child_process", () => childProcessMocks);

import type { PDVConfig } from "./config";
import { IPC } from "./ipc";
import { registerLaunchersIpcHandlers } from "./ipc-register-launchers";

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = ipcRegistry.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler;
}

interface SetupOverrides {
  config?: Partial<PDVConfig>;
  activeKernelId?: string | null;
  workingDirs?: [string, string][];
}

function setup(overrides: SetupOverrides = {}): void {
  const activeKernelId =
    "activeKernelId" in overrides ? (overrides.activeKernelId ?? null) : "k1";
  registerLaunchersIpcHandlers({
    kernelWorkingDirs: new Map(overrides.workingDirs ?? [["k1", "/tmp/wd"]]),
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => null,
    getConfig: () =>
      ({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        autoRefreshNamespace: false,
        ...overrides.config,
      }) as PDVConfig,
    getMcpStatus: () => null,
  });
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("launchers.openWorkingDir", () => {
  it("opens the working dir with the configured dirCommand (no terminal wrap)", async () => {
    setup({ config: { launchers: { editor: { dirCommand: "code {}" } } } });
    const result = await getHandler(IPC.launchers.openWorkingDir)({});
    expect(result).toEqual({ success: true });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "code",
      ["/tmp/wd"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("defaults to `code {}` when no dirCommand is configured", async () => {
    setup();
    await getHandler(IPC.launchers.openWorkingDir)({});
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "code",
      ["/tmp/wd"],
      expect.any(Object),
    );
  });

  it("does not wrap a TUI-named dir command in a terminal", async () => {
    // `wrapInTerminal: false` is forced for directory opens, so even a
    // vim-like command spawns directly rather than via a terminal preset.
    setup({ config: { launchers: { editor: { dirCommand: "vim {}" } } } });
    await getHandler(IPC.launchers.openWorkingDir)({});
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "vim",
      ["/tmp/wd"],
      expect.any(Object),
    );
  });

  it("returns an error when no kernel is active", async () => {
    setup({ activeKernelId: null });
    const result = await getHandler(IPC.launchers.openWorkingDir)({});
    expect(result).toEqual({ success: false, error: expect.stringContaining("No active kernel") });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("returns an error when the active kernel has no working dir", async () => {
    setup({ activeKernelId: "ghost", workingDirs: [["k1", "/tmp/wd"]] });
    const result = await getHandler(IPC.launchers.openWorkingDir)({});
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("No working directory"),
    });
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });
});
