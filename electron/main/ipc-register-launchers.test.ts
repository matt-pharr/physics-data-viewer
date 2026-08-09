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
import {
  registerLaunchersIpcHandlers,
  type RemoteLauncherContext,
} from "./ipc-register-launchers";

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
  remoteContext?: RemoteLauncherContext | null;
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
    getRemoteContext: () => overrides.remoteContext ?? null,
  });
}

/** A connected remote session on feyn with a PDV-owned master. */
const FEYN: RemoteLauncherContext = {
  host: "feyn",
  control: { host: "feyn", controlPath: "/tmp/ctl/m-ab" },
};

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

describe("remote routing", () => {
  it("script:edit routes a Remote-SSH-capable editor through --remote, never a bare cluster path", async () => {
    setup({
      remoteContext: FEYN,
      config: { launchers: { editor: { fileCommand: "code {}" } } },
      resolveTreeFile: async () => "/u/mp/proj/tree/ab12/run.py",
    });
    const result = (await getHandler(IPC.script.edit)({}, "k1", "scripts.run")) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "code",
      ["--remote", "ssh-remote+feyn", "/u/mp/proj/tree/ab12/run.py"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("script:edit wraps a TUI editor in the terminal preset running ssh -t over the master", async () => {
    setup({
      remoteContext: FEYN,
      config: {
        launchers: {
          editor: { fileCommand: "vim {}" },
          terminal: { preset: "kitty" },
        },
      },
      resolveTreeFile: async () => "/u/mp/f.py",
    });
    const result = (await getHandler(IPC.script.edit)({}, "k1", "scripts.f")) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    // kitty on darwin: open -na kitty --args -- {cmd}; cmd = the ssh argv.
    const [file, args] = childProcessMocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    const argv = [file, ...args].join(" ");
    expect(argv).toContain("ssh -t");
    expect(argv).toContain(`ControlPath="/tmp/ctl/m-ab"`);
    expect(argv).toContain("feyn");
    expect(argv).toContain(`'vim' '/u/mp/f.py'`);
  });

  it("script:edit refuses an editor with no remote story instead of spawning", async () => {
    setup({
      remoteContext: FEYN,
      config: { launchers: { editor: { fileCommand: "subl {}" } } },
      resolveTreeFile: async () => "/u/mp/f.py",
    });
    const result = (await getHandler(IPC.script.edit)({}, "k1", "scripts.f")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("subl");
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("script:edit refuses ssh-carried launches while the connection is down", async () => {
    setup({
      remoteContext: { host: "feyn", control: null },
      config: { launchers: { editor: { fileCommand: "vim {}" } } },
      resolveTreeFile: async () => "/u/mp/f.py",
    });
    const result = (await getHandler(IPC.script.edit)({}, "k1", "scripts.f")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reconnect/i);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("openWorkingDir routes the dir through --remote too", async () => {
    setup({ remoteContext: FEYN });
    const result = (await getHandler(IPC.launchers.openWorkingDir)({})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "code",
      ["--remote", "ssh-remote+feyn", "/tmp/wd"],
      expect.any(Object),
    );
  });

  it("openAgent refuses in a remote session BEFORE any mcp/config work", async () => {
    setup({ remoteContext: FEYN });
    const result = (await getHandler(IPC.launchers.openAgent)({})) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/remote sessions/);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });
});

describe("launchers.openTerminal", () => {
  it("opens the terminal preset around a local login shell cd'ed to the working dir", async () => {
    setup({ config: { launchers: { terminal: { preset: "kitty" } } } });
    const result = (await getHandler(IPC.launchers.openTerminal)({})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    const [file, args] = childProcessMocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    const argv = [file, ...args].join(" ");
    expect(argv).toContain("sh -c");
    expect(argv).toContain("cd '/tmp/wd'; exec");
  });

  it("remotely runs ssh -t to a login shell in the session working dir", async () => {
    setup({
      remoteContext: FEYN,
      config: { launchers: { terminal: { preset: "kitty" } } },
    });
    const result = (await getHandler(IPC.launchers.openTerminal)({})) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    const [file, args] = childProcessMocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    const argv = [file, ...args].join(" ");
    expect(argv).toContain("ssh -t");
    expect(argv).toContain("feyn");
    expect(argv).toContain("cd '/tmp/wd'; exec");
  });

  it("refuses when the terminal preset is 'none'", async () => {
    setup({ config: { launchers: { terminal: { preset: "none" } } } });
    const result = (await getHandler(IPC.launchers.openTerminal)({})) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/'None'/);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("refuses remotely while the connection is down instead of falling back to local", async () => {
    setup({
      remoteContext: { host: "feyn", control: null },
      config: { launchers: { terminal: { preset: "kitty" } } },
    });
    const result = (await getHandler(IPC.launchers.openTerminal)({})) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reconnect/i);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("returns an error when no kernel is active", async () => {
    setup({ activeKernelId: null });
    const result = (await getHandler(IPC.launchers.openTerminal)({})) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain("No active kernel");
  });
});
