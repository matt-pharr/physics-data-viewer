// @vitest-environment jsdom

/**
 * useProjectWorkflow.test.ts — Unit tests for the project save/load hook.
 *
 * Covers: kernel-not-ready guard on save, SaveAs-on-first-save trigger,
 * direct-save path with directory provided, missing-files-blocks-save with
 * warning logged, load happy path with checksum/version, load checksum
 * mismatch flag, load with autosave-recovery branch (and recovery decline),
 * recent-projects dedupe + cap, and menu listener subscription/cleanup.
 */

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHookWithPdv } from "../test-fixtures/hook-helpers";
import { TEST_PDV_VERSION } from "../test-fixtures/test-pdv-version";
import type {
  CellTab,
  Config,
  LogEntry,
  MenuActionPayload,
} from "../types";
import type { ProgressPayload } from "../types/pdv";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { MAX_RECENT_PROJECTS } from "./constants";

type KernelStatus = "idle" | "starting" | "ready" | "error";

interface State {
  currentProjectDir: string | null;
  currentProjectName: string | null;
  cellTabs: CellTab[];
  activeCellTab: number;
  config: Config | null;
  logs: LogEntry[];
  modulesRefreshToken: number;
  progress: ProgressPayload | null;
  lastError: string | undefined;
  lastChecksum: string | null;
  checksumMismatch: boolean;
  savedPdvVersion: string | null;
  showSaveAsDialog: boolean;
}

function createState(overrides: Partial<State> = {}): {
  state: State;
  setters: Parameters<typeof useProjectWorkflow>[0];
  loadedProjectTabsRef: { current: { tabs: CellTab[]; activeTabId: number } | null };
  flushDirtyNotes: ReturnType<typeof vi.fn>;
} {
  const state: State = {
    currentProjectDir: null,
    currentProjectName: null,
    cellTabs: [{ id: 1, code: "print(1)" }],
    activeCellTab: 1,
    config: { recentProjects: [] } as Config,
    logs: [],
    modulesRefreshToken: 0,
    progress: null,
    lastError: undefined,
    lastChecksum: null,
    checksumMismatch: false,
    savedPdvVersion: null,
    showSaveAsDialog: false,
    ...overrides,
  };
  const apply = <K extends keyof State>(
    key: K,
    v: State[K] | ((prev: State[K]) => State[K]),
  ): void => {
    state[key] = typeof v === "function" ? (v as (prev: State[K]) => State[K])(state[key]) : v;
  };
  const loadedProjectTabsRef: {
    current: { tabs: CellTab[]; activeTabId: number } | null;
  } = { current: null };
  const flushDirtyNotes = vi.fn(async () => undefined);

  const setters: Parameters<typeof useProjectWorkflow>[0] = {
    kernelStatus: "ready",
    currentProjectDir: state.currentProjectDir,
    cellTabs: state.cellTabs,
    activeCellTab: state.activeCellTab,
    config: state.config,
    setConfig: ((v: unknown) => apply("config", v as never)) as never,
    setCurrentProjectDir: ((v: unknown) => apply("currentProjectDir", v as never)) as never,
    setCellTabs: ((v: unknown) => apply("cellTabs", v as never)) as never,
    setActiveCellTab: ((v: unknown) => apply("activeCellTab", v as never)) as never,
    setModulesRefreshToken: ((v: unknown) => apply("modulesRefreshToken", v as never)) as never,
    currentKernelId: "k1",
    setProgress: ((v: unknown) => apply("progress", v as never)) as never,
    setLastError: ((v: unknown) => apply("lastError", v as never)) as never,
    setLogs: ((v: unknown) => apply("logs", v as never)) as never,
    setLastChecksum: ((v: unknown) => apply("lastChecksum", v as never)) as never,
    setChecksumMismatch: ((v: unknown) => apply("checksumMismatch", v as never)) as never,
    setSavedPdvVersion: ((v: unknown) => apply("savedPdvVersion", v as never)) as never,
    setCurrentProjectName: ((v: unknown) => apply("currentProjectName", v as never)) as never,
    openSaveAsDialog: (() => apply("showSaveAsDialog", true as never)) as never,
    loadedProjectTabsRef: loadedProjectTabsRef as never,
    normalizeLoadedCodeCells: (data: unknown) => {
      const d = data as { tabs?: CellTab[]; activeTabId?: number } | null;
      return {
        tabs: d?.tabs ?? [{ id: 1, code: "" }],
        activeTabId: d?.activeTabId ?? 1,
      };
    },
    flushDirtyNotes,
  };
  return { state, setters, loadedProjectTabsRef, flushDirtyNotes };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useProjectWorkflow.handleSaveProject", () => {
  it("returns false silently when kernelStatus is not 'ready'", async () => {
    const { state, setters } = createState();
    const { result, pdv } = renderHookWithPdv(() =>
      useProjectWorkflow({ ...setters, kernelStatus: "starting" as KernelStatus }),
    );
    let r: boolean | undefined;
    await act(async () => {
      r = await result.current.handleSaveProject();
    });
    expect(r).toBe(false);
    expect(pdv.project.save).not.toHaveBeenCalled();
    expect(state.showSaveAsDialog).toBe(false);
  });

  it("first save with no current project dir opens the SaveAs dialog", async () => {
    const { state, setters } = createState();
    const { result, pdv } = renderHookWithPdv(() => useProjectWorkflow(setters));
    let r: boolean | undefined;
    await act(async () => {
      r = await result.current.handleSaveProject();
    });
    expect(r).toBe(false);
    expect(state.showSaveAsDialog).toBe(true);
    expect(pdv.project.save).not.toHaveBeenCalled();
  });

  it("subsequent saves with currentProjectDir set call pdv.project.save and skip dialog", async () => {
    const { state, setters } = createState({ currentProjectDir: "/projects/x" });
    const { result, pdv } = renderHookWithPdv(
      () => useProjectWorkflow({ ...setters, currentProjectDir: "/projects/x" }),
      {
        pdvOverrides: {
          project: {
            save: vi.fn(async () => ({
              checksum: "abcdef123456",
              nodeCount: 5,
              projectName: "demo",
            })) as never,
          },
        },
      },
    );
    let r: boolean | undefined;
    await act(async () => {
      r = await result.current.handleSaveProject();
    });
    expect(r).toBe(true);
    expect(state.showSaveAsDialog).toBe(false);
    expect(pdv.project.save).toHaveBeenCalledTimes(1);
    expect(state.currentProjectDir).toBe("/projects/x");
    expect(state.lastChecksum).toBe("abcdef");
    expect(state.checksumMismatch).toBe(false);
    expect(state.modulesRefreshToken).toBe(1);
  });

  it("missing backing files block the save and append a warning to logs", async () => {
    const { state, setters } = createState({ currentProjectDir: "/projects/x" });
    const { result, pdv } = renderHookWithPdv(
      () => useProjectWorkflow({ ...setters, currentProjectDir: "/projects/x" }),
      {
        pdvOverrides: {
          project: {
            save: vi.fn(async () => ({
              checksum: "x",
              nodeCount: 0,
              missingFiles: ["foo.npy", "bar.npy"],
            })) as never,
          },
        },
      },
    );
    let r: boolean | undefined;
    await act(async () => {
      r = await result.current.handleSaveProject();
    });
    expect(r).toBe(false);
    expect(pdv.project.save).toHaveBeenCalledTimes(1);
    expect(state.currentProjectDir).toBe("/projects/x"); // unchanged
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0].stderr).toMatch(/Save blocked/);
    expect(state.logs[0].stderr).toMatch(/foo\.npy/);
  });

  it("failed-to-serialize nodes complete the save but append a loud warning (review)", async () => {
    const { state, setters } = createState({ currentProjectDir: "/projects/x" });
    const { result } = renderHookWithPdv(
      () => useProjectWorkflow({ ...setters, currentProjectDir: "/projects/x" }),
      {
        pdvOverrides: {
          project: {
            save: vi.fn(async () => ({
              checksum: "abcdef123456",
              nodeCount: 5,
              failedNodes: [
                { path: "sim.task", type: "Task", error: "cannot serialize a running Task", preserved: true },
                { path: "sim.chan", type: "Channel{Any}", error: "cannot serialize", preserved: false },
              ],
            })) as never,
          },
        },
      },
    );
    let r: boolean | undefined;
    await act(async () => {
      r = await result.current.handleSaveProject();
    });
    // The save itself completed…
    expect(r).toBe(true);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0].stdout).toMatch(/Project saved/);
    // …but must not be indistinguishable from a clean one.
    expect(state.logs[0].stderr).toMatch(/2 node\(s\) could not be serialized/);
    expect(state.logs[0].stderr).toMatch(/sim\.task — cannot serialize a running Task \(previous saved value kept\)/);
    expect(state.logs[0].stderr).toMatch(/sim\.chan — cannot serialize \(NOT in this save\)/);
  });

  it("calls flushDirtyNotes before saving so dirty markdown reaches disk", async () => {
    const { setters, flushDirtyNotes } = createState({
      currentProjectDir: "/projects/x",
    });
    const { result } = renderHookWithPdv(() =>
      useProjectWorkflow({ ...setters, currentProjectDir: "/projects/x" }),
    );
    await act(async () => {
      await result.current.handleSaveProject();
    });
    expect(flushDirtyNotes).toHaveBeenCalledTimes(1);
  });
});

describe("useProjectWorkflow.executeOpenProject", () => {
  it("returns silently when kernelStatus is not 'ready'", async () => {
    const { setters } = createState();
    const { result, pdv } = renderHookWithPdv(() =>
      useProjectWorkflow({ ...setters, kernelStatus: "idle" as KernelStatus }),
    );
    await act(async () => {
      await result.current.executeOpenProject("/some/dir");
    });
    expect(pdv.project.load).not.toHaveBeenCalled();
  });

  it("happy path: loads project, sets dir/name/checksum, restores tabs via ref", async () => {
    const { state, setters, loadedProjectTabsRef } = createState();
    const { result } = renderHookWithPdv(
      () => useProjectWorkflow(setters),
      {
        pdvOverrides: {
          project: {
            load: vi.fn(async () => ({
              codeCells: { tabs: [{ id: 7, code: "loaded" }], activeTabId: 7 },
              checksum: "deadbeef0000",
              checksumValid: true,
              nodeCount: 3,
              savedPdvVersion: TEST_PDV_VERSION,
              projectName: "loaded-demo",
              missingFiles: undefined,
            })) as never,
          },
        },
      },
    );

    await act(async () => {
      await result.current.executeOpenProject("/projects/loaded");
    });

    expect(state.currentProjectDir).toBe("/projects/loaded");
    expect(state.currentProjectName).toBe("loaded-demo");
    expect(state.cellTabs).toEqual([{ id: 7, code: "loaded" }]);
    expect(state.activeCellTab).toBe(7);
    expect(state.lastChecksum).toBe("deadbe");
    expect(state.checksumMismatch).toBe(false);
    expect(state.savedPdvVersion).toBe(TEST_PDV_VERSION);
    expect(loadedProjectTabsRef.current).toEqual({
      tabs: [{ id: 7, code: "loaded" }],
      activeTabId: 7,
    });
  });

  it("checksum mismatch surfaces as state.checksumMismatch=true", async () => {
    const { state, setters } = createState();
    const { result } = renderHookWithPdv(() => useProjectWorkflow(setters), {
      pdvOverrides: {
        project: {
          load: vi.fn(async () => ({
            codeCells: { tabs: [], activeTabId: 1 },
            checksum: "x",
            checksumValid: false,
            nodeCount: 1,
            savedPdvVersion: null,
            projectName: null,
          })) as never,
        },
      },
    });
    await act(async () => {
      await result.current.executeOpenProject("/projects/mis");
    });
    expect(state.checksumMismatch).toBe(true);
  });

  it("autosave-recovery branch: declining recovery clears the autosave dir", async () => {
    const { setters } = createState();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const clearMock = vi.fn(async () => undefined);
    const { result, pdv } = renderHookWithPdv(() => useProjectWorkflow(setters), {
      pdvOverrides: {
        autosave: {
          check: vi.fn(async () => ({
            exists: true,
            timestamp: "2026-05-05T10:00:00Z",
          })) as never,
          clear: clearMock as never,
        },
        project: {
          load: vi.fn(async () => ({
            codeCells: null,
            checksum: null,
            checksumValid: null,
            nodeCount: 0,
            savedPdvVersion: null,
            projectName: null,
          })) as never,
        },
      },
    });
    await act(async () => {
      await result.current.executeOpenProject("/projects/auto");
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(pdv.autosave.clear).toHaveBeenCalledWith("/projects/auto");
    expect(pdv.project.load).toHaveBeenCalledWith("/projects/auto", undefined);
  });

  it("opens directory picker when no directory argument is given", async () => {
    const { setters } = createState();
    const { result, pdv } = renderHookWithPdv(() => useProjectWorkflow(setters), {
      pdvOverrides: {
        files: {
          pickDirectory: vi.fn(async () => "/projects/picked") as never,
        },
        project: {
          load: vi.fn(async () => ({
            codeCells: null,
            checksum: null,
            checksumValid: null,
            nodeCount: 0,
            savedPdvVersion: null,
            projectName: null,
          })) as never,
        },
      },
    });
    await act(async () => {
      await result.current.executeOpenProject();
    });
    expect(pdv.files.pickDirectory).toHaveBeenCalled();
    expect(pdv.project.load).toHaveBeenCalledWith("/projects/picked", undefined);
  });

  it("returns silently when the directory picker is cancelled", async () => {
    const { setters } = createState();
    const { result, pdv } = renderHookWithPdv(() => useProjectWorkflow(setters), {
      pdvOverrides: {
        files: {
          pickDirectory: vi.fn(async () => null) as never,
        },
      },
    });
    await act(async () => {
      await result.current.executeOpenProject();
    });
    expect(pdv.project.load).not.toHaveBeenCalled();
  });
});

describe("useProjectWorkflow recent-projects bookkeeping", () => {
  it("dedupes existing entries and caps to MAX_RECENT_PROJECTS", async () => {
    const initialRecents = Array.from(
      { length: MAX_RECENT_PROJECTS },
      (_, i) => `/projects/old-${i}`,
    );
    const { setters } = createState({
      currentProjectDir: "/projects/x",
      config: { recentProjects: initialRecents } as Config,
    });
    const setMock = vi.fn(async (cfg) => cfg as never);
    const { result, pdv } = renderHookWithPdv(
      () =>
        useProjectWorkflow({
          ...setters,
          currentProjectDir: "/projects/x",
          config: { recentProjects: initialRecents } as Config,
        }),
      {
        pdvOverrides: {
          config: { set: setMock as never },
          project: {
            save: vi.fn(async () => ({
              checksum: "abc",
              nodeCount: 1,
              projectName: "x",
            })) as never,
          },
        },
      },
    );
    await act(async () => {
      await result.current.handleSaveProject();
    });
    expect(pdv.config.set).toHaveBeenCalledTimes(1);
    const { recentProjects } = (pdv.config.set as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { recentProjects: string[] };
    // The newly saved dir is at the front, no duplicates, length capped.
    expect(recentProjects[0]).toBe("/projects/x");
    expect(new Set(recentProjects).size).toBe(recentProjects.length);
    expect(recentProjects.length).toBeLessThanOrEqual(MAX_RECENT_PROJECTS);
  });
});

describe("useProjectWorkflow menu listener", () => {
  it("subscribes to pdv.menu.onAction on mount and unsubscribes on unmount", () => {
    const { setters } = createState();
    const unsubscribe = vi.fn();
    const onAction = vi.fn(() => unsubscribe);
    const { unmount, pdv } = renderHookWithPdv(
      () => useProjectWorkflow(setters),
      {
        pdvOverrides: {
          menu: { onAction: onAction as never },
        },
      },
    );
    expect(pdv.menu.onAction).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("project:save action triggers handleSaveProject", async () => {
    const { setters } = createState({ currentProjectDir: "/projects/x" });
    let capturedHandler: ((payload: MenuActionPayload) => void) | null = null;
    const onActionMock = vi.fn((handler: (payload: MenuActionPayload) => void) => {
      capturedHandler = handler;
      return () => undefined;
    });
    const saveMock = vi.fn(async () => ({
      checksum: "abc",
      nodeCount: 0,
      projectName: "x",
    }));
    renderHookWithPdv(
      () => useProjectWorkflow({ ...setters, currentProjectDir: "/projects/x" }),
      {
        pdvOverrides: {
          menu: { onAction: onActionMock as never },
          project: { save: saveMock as never },
        },
      },
    );
    expect(capturedHandler).toBeTruthy();
    await act(async () => {
      capturedHandler!({ action: "project:save" } as MenuActionPayload);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveMock).toHaveBeenCalled();
  });
});
