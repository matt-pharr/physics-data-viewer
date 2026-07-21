// @vitest-environment jsdom

/**
 * useKernelLifecycle.test.ts — Unit tests for the kernel start/restart hook.
 *
 * Covers: startKernel happy path with state transitions, error path,
 * concurrent-call queuing (only the latest queued call resolves true),
 * handleEnvSave config-then-start chain, handleRestartKernel clearing logs
 * and dropping kernel-scoped query caches.
 */

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHookWithPdv } from "../test-fixtures/hook-helpers";
import type { Config, KernelInfo } from "../types/pdv";
import type { LogEntry } from "../types";
import { useKernelLifecycle } from "./useKernelLifecycle";
import { invalidateAllKernelState } from "../queries/invalidation";

vi.mock("../queries/invalidation", () => ({
  invalidateAllKernelState: vi.fn(),
}));

type KernelStatus = "idle" | "starting" | "ready" | "error";

interface State {
  currentKernelId: string | null;
  kernelStatus: KernelStatus;
  lastError: string | undefined;
  config: Config | null;
  logs: LogEntry[];
}

interface Setters {
  setCurrentKernelId: (v: string | null | ((prev: string | null) => string | null)) => void;
  setKernelStatus: (v: KernelStatus | ((prev: KernelStatus) => KernelStatus)) => void;
  setLastError: (v: string | undefined | ((prev: string | undefined) => string | undefined)) => void;
  setConfig: (v: Config | null | ((prev: Config | null) => Config | null)) => void;
  setLogs: (v: LogEntry[] | ((prev: LogEntry[]) => LogEntry[])) => void;
  setEnvironmentMode: (v: 'uv' | 'shared' | 'pkg' | ((prev: 'uv' | 'shared' | 'pkg') => 'uv' | 'shared' | 'pkg')) => void;
}

function createState(): { state: State; setters: Setters } {
  const state: State = {
    currentKernelId: null,
    kernelStatus: "idle",
    lastError: undefined,
    config: { pythonPath: "/usr/bin/python3" } as Config,
    logs: [],
  };
  const apply = <K extends keyof State>(key: K, v: State[K] | ((prev: State[K]) => State[K])): void => {
    state[key] = typeof v === "function" ? (v as (prev: State[K]) => State[K])(state[key]) : v;
  };
  const setters: Setters = {
    setCurrentKernelId: (v) => apply("currentKernelId", v as never),
    setKernelStatus: (v) => apply("kernelStatus", v as never),
    setLastError: (v) => apply("lastError", v as never),
    setConfig: (v) => apply("config", v as never),
    setLogs: (v) => apply("logs", v as never),
    setEnvironmentMode: () => {},
  };
  return { state, setters };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useKernelLifecycle.startKernel", () => {
  it("happy path: status idle → starting → ready, sets kernel id, clears kernel cache", async () => {
    const { state, setters } = createState();
    const kernelInfo: KernelInfo = {
      id: "k1",
      name: "python3",
      language: "python",
      status: "idle",
    };
    const { result, pdv } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: {
            start: vi.fn(async () => kernelInfo) as never,
          },
        },
      },
    );

    let success: boolean = false;
    await act(async () => {
      success = await result.current.startKernel(state.config!);
    });
    expect(success).toBe(true);
    expect(pdv.kernels.start).toHaveBeenCalledTimes(1);
    expect(state.currentKernelId).toBe("k1");
    expect(state.kernelStatus).toBe("ready");
    expect(state.lastError).toBeUndefined();
    // Fresh kernel id — cache cleared for it in case the id was reused.
    expect(invalidateAllKernelState).toHaveBeenCalledWith("k1", "kernel-switch");
  });

  it("failure path: sets status error and lastError, leaves currentKernelId null", async () => {
    const { state, setters } = createState();
    const { result } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: {
            start: vi.fn(async () => {
              throw new Error("python not found");
            }) as never,
          },
        },
      },
    );

    let success: boolean = true;
    await act(async () => {
      success = await result.current.startKernel(state.config!);
    });
    expect(success).toBe(false);
    expect(state.kernelStatus).toBe("error");
    expect(state.lastError).toBe("python not found");
    expect(state.currentKernelId).toBeNull();
  });

  it("concurrent calls: only the latest queued call invokes pdv.kernels.start; earlier calls resolve false", async () => {
    // The hook's queue logic: each new startKernel() sets pendingStartRef to
    // its own resolver, and any *previous* pending resolver gets called with
    // false right then. So when 3 calls fire back-to-back, only the third one
    // actually runs through doStartKernel — the first two have already been
    // replaced and resolve false.
    const { state, setters } = createState();
    const startMock = vi.fn(async () => ({
      id: "k1",
      name: "python3",
      language: "python" as const,
      status: "idle" as const,
    }));
    const { result } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: { start: startMock as never },
        },
      },
    );

    await act(async () => {
      const p1 = result.current.startKernel(state.config!);
      const p2 = result.current.startKernel(state.config!);
      const p3 = result.current.startKernel(state.config!);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe(false);
      expect(r2).toBe(false);
      expect(r3).toBe(true);
    });
    expect(startMock).toHaveBeenCalledTimes(1);
  });
});

describe("useKernelLifecycle.handleEnvSave", () => {
  it("writes config first, then calls startKernel with the merged config", async () => {
    const { state, setters } = createState();
    const startMock = vi.fn(async () => ({
      id: "k1",
      name: "python3",
      language: "python" as const,
      status: "idle" as const,
    }));
    const { result, pdv } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: { start: startMock as never },
          config: { set: vi.fn(async (cfg) => cfg as never) as never },
        },
      },
    );

    await act(async () => {
      await result.current.handleEnvSave({ pythonPath: "/opt/python3.12" });
    });

    expect(pdv.config.set).toHaveBeenCalledTimes(1);
    expect(pdv.config.set).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: "/opt/python3.12" }),
    );
    expect(pdv.kernels.start).toHaveBeenCalledTimes(1);
    expect(state.config?.pythonPath).toBe("/opt/python3.12");
  });

  it("restart: false writes config without touching the running kernel (§10.5.19)", async () => {
    // Guards the Default Runtime tab's future-sessions-only behavior: with a
    // session up, selecting an environment must never stop/restart it (the
    // old behavior silently demoted uv projects to shared mode).
    const { state, setters } = createState();
    state.currentKernelId = "k1";
    const startMock = vi.fn();
    const stopMock = vi.fn();
    const { result, pdv } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: { start: startMock as never, stop: stopMock as never },
          config: { set: vi.fn(async (cfg) => cfg as never) as never },
        },
      },
    );

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.handleEnvSave(
        { pythonPath: "/opt/conda/bin/python" },
        { restart: false },
      );
    });

    expect(ok).toBe(true);
    expect(pdv.config.set).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: "/opt/conda/bin/python" }),
    );
    expect(state.config?.pythonPath).toBe("/opt/conda/bin/python");
    expect(startMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
  });
});

describe("useKernelLifecycle.handleRestartKernel", () => {
  it("calls pdv.kernels.restart, seeds a restored-state log entry, purges kernel caches", async () => {
    const { state, setters } = createState();
    state.currentKernelId = "k1";
    state.logs = [{ executionId: "e1", chunks: [] } as never];
    const restartMock = vi.fn(async () => ({
      kernel: {
        id: "k2",
        name: "python3",
        language: "python" as const,
        status: "idle" as const,
      },
      restoredFromAutosave: true,
    }));
    const { result, pdv } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: { restart: restartMock as never },
        },
      },
    );

    await act(async () => {
      await result.current.handleRestartKernel();
    });

    expect(pdv.kernels.restart).toHaveBeenCalledWith("k1");
    expect(state.currentKernelId).toBe("k2");
    // The log history is replaced with a single info entry saying what
    // came back (restored vs fresh).
    expect(state.logs).toHaveLength(1);
    expect((state.logs[0] as { stdout?: string }).stdout).toMatch(/restored from the last autosave/i);
    // Both the pre-restart and post-restart kernel ids are purged.
    expect(invalidateAllKernelState).toHaveBeenCalledWith("k1", "kernel-switch");
    expect(invalidateAllKernelState).toHaveBeenCalledWith("k2", "kernel-switch");
  });

  it("reports a fresh session when nothing was restored", async () => {
    const { state, setters } = createState();
    state.currentKernelId = "k1";
    const restartMock = vi.fn(async () => ({
      kernel: {
        id: "k2",
        name: "python3",
        language: "python" as const,
        status: "idle" as const,
      },
      restoredFromAutosave: false,
    }));
    const { result } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: { restart: restartMock as never },
        },
      },
    );

    await act(async () => {
      await result.current.handleRestartKernel();
    });

    expect(state.logs).toHaveLength(1);
    expect((state.logs[0] as { stdout?: string }).stdout).toMatch(/no autosave found/i);
  });

  it("no-op when there is no active kernel", async () => {
    const { state, setters } = createState();
    const restartMock = vi.fn();
    const { result, pdv } = renderHookWithPdv(
      () =>
        useKernelLifecycle({
          config: state.config,
          currentKernelId: state.currentKernelId,
          ...setters,
        }),
      {
        pdvOverrides: {
          kernels: { restart: restartMock as never },
        },
      },
    );
    await act(async () => {
      await result.current.handleRestartKernel();
    });
    expect(pdv.kernels.restart).not.toHaveBeenCalled();
  });
});
