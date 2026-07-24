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
  resolveTreeFile?: (treePath: string) => Promise<string | null>;
}

function setup(overrides: SetupOverrides = {}): void {
  const activeKernelId =
    "activeKernelId" in overrides ? (overrides.activeKernelId ?? null) : "k1";
  const workingDirs = new Map(overrides.workingDirs ?? [["k1", "/tmp/wd"]]);
  registerLaunchersIpcHandlers({
    getLauncherContext: async () => ({
      kernelId: activeKernelId,
      workingDir: activeKernelId ? (workingDirs.get(activeKernelId) ?? null) : null,
      projectDir: null,
    }),
    getConfig: async () =>
      ({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        autoRefreshNamespace: false,
        ...overrides.config,
      }) as PDVConfig,
    getMcpStatus: async () => null,
    resolveTreeFile: overrides.resolveTreeFile ?? (async () => null),
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

describe("script:edit", () => {
  it("returns success:false when the kernel cannot resolve a file path", async () => {
    setup({ resolveTreeFile: async () => null });
    const result = (await getHandler(IPC.script.edit)({}, "k1", "missing.script")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not resolve/);
  });

  it("spawns the editor process with resolved path and detached child handles", async () => {
    setup({
      config: { launchers: { editor: { fileCommand: "code {}" } } },
      resolveTreeFile: async () => "/tmp/wd/scripts/demo.py",
    });
    const result = (await getHandler(IPC.script.edit)({}, "k1", "scripts.demo")) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "code",
      ["/tmp/wd/scripts/demo.py"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });
});
