// @vitest-environment jsdom

/**
 * useKernelSubscriptions.test.ts — Unit tests for the push-subscription hook.
 *
 * Pins the streamed-output coalescing contract: chunks arriving between
 * flush intervals are buffered and applied to the log state in a single
 * update, and buffered output is not lost when the subscription tears down.
 */

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHookWithPdv } from "../test-fixtures/hook-helpers";
import type { LogEntry } from "../types";
import type { ExecuteOutputChunk } from "../types/pdv";
import { useKernelSubscriptions } from "./useKernelSubscriptions";
import { applyTreeChange, invalidateTree } from "../queries/invalidation";

vi.mock("../queries/invalidation", () => ({
  applyTreeChange: vi.fn(),
  invalidateTree: vi.fn(),
}));

type TreeChangedPayload = {
  changed_paths: string[];
  change_type: "added" | "removed" | "updated" | "batch" | "unknown";
};

type LogsUpdate = LogEntry[] | ((prev: LogEntry[]) => LogEntry[]);

function renderSubscriptions(initialLogs: LogEntry[], kernelId: string | null = null) {
  let logs = initialLogs;
  const setLogs = vi.fn((update: LogsUpdate) => {
    logs = typeof update === "function" ? update(logs) : update;
  });
  const setModulesRefreshToken = vi.fn();
  let outputCallback: ((chunk: ExecuteOutputChunk) => void) | undefined;
  let treeChangedCallback: ((payload: TreeChangedPayload) => void) | undefined;
  const rendered = renderHookWithPdv(
    () =>
      useKernelSubscriptions({
        currentKernelId: kernelId,
        loadedProjectTabsRef: { current: null },
        setCellTabs: vi.fn(),
        setActiveCellTab: vi.fn(),
        setLogs,
        setModulesRefreshToken,
        setProjectReloading: vi.fn(),
        setProgress: vi.fn(),
        onKernelCrash: vi.fn(),
        setKernelMemoryRss: vi.fn(),
      }),
    {
      pdvOverrides: {
        kernels: {
          onOutput: vi.fn((cb: (chunk: ExecuteOutputChunk) => void) => {
            outputCallback = cb;
            return () => {};
          }),
        },
        tree: {
          onChanged: vi.fn((cb: (payload: TreeChangedPayload) => void) => {
            treeChangedCallback = cb;
            return () => {};
          }),
        },
      },
    },
  );
  return {
    ...rendered,
    setLogs,
    setModulesRefreshToken,
    getLogs: () => logs,
    emitChunk: (chunk: ExecuteOutputChunk) => outputCallback?.(chunk),
    emitTreeChange: (payload: TreeChangedPayload) => treeChangedCallback?.(payload),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useKernelSubscriptions output coalescing", () => {
  const seedEntry: LogEntry = { id: "exec-1", timestamp: 0, code: "run()" };

  it("applies a burst of chunks as a single setLogs update", () => {
    const { setLogs, getLogs, emitChunk } = renderSubscriptions([seedEntry]);

    act(() => {
      emitChunk({ executionId: "exec-1", type: "stdout", text: "a" });
      emitChunk({ executionId: "exec-1", type: "stdout", text: "b" });
      emitChunk({ executionId: "exec-1", type: "stderr", text: "warn" });
    });
    expect(setLogs).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(setLogs).toHaveBeenCalledTimes(1);
    expect(getLogs()).toEqual([
      { ...seedEntry, stdout: "ab", stderr: "warn" },
    ]);
  });

  it("leaves entries for other executions untouched (identity preserved)", () => {
    const other: LogEntry = { id: "exec-0", timestamp: 0, code: "", stdout: "done" };
    const { getLogs, emitChunk } = renderSubscriptions([other, seedEntry]);

    act(() => {
      emitChunk({ executionId: "exec-1", type: "stdout", text: "x" });
      vi.advanceTimersByTime(20);
    });
    expect(getLogs()[0]).toBe(other);
    expect(getLogs()[1]).toEqual({ ...seedEntry, stdout: "x" });
  });

  it("flushes buffered chunks on teardown instead of dropping them", () => {
    const { setLogs, getLogs, emitChunk, unmount } = renderSubscriptions([seedEntry]);

    act(() => {
      emitChunk({ executionId: "exec-1", type: "stdout", text: "tail" });
    });
    expect(setLogs).not.toHaveBeenCalled();

    unmount();
    expect(setLogs).toHaveBeenCalledTimes(1);
    expect(getLogs()).toEqual([{ ...seedEntry, stdout: "tail" }]);
  });

  it("accumulates images and records results within one flush", () => {
    const { getLogs, emitChunk } = renderSubscriptions([seedEntry]);

    act(() => {
      emitChunk({
        executionId: "exec-1",
        type: "image",
        image: { mime: "image/png", data: "AAA" },
      });
      emitChunk({ executionId: "exec-1", type: "result", result: 42 });
      vi.advanceTimersByTime(20);
    });
    expect(getLogs()).toEqual([
      { ...seedEntry, images: [{ mime: "image/png", data: "AAA" }], result: 42 },
    ]);
  });
});

describe("useKernelSubscriptions tree-change mapping", () => {
  it("routes every tree.onChanged payload through applyTreeChange for the active kernel", () => {
    const { emitTreeChange, setModulesRefreshToken } = renderSubscriptions([], "k1");

    const payload: TreeChangedPayload = { changed_paths: ["a.b"], change_type: "updated" };
    act(() => {
      emitTreeChange(payload);
    });

    expect(applyTreeChange).toHaveBeenCalledTimes(1);
    expect(applyTreeChange).toHaveBeenCalledWith("k1", payload);
    expect(setModulesRefreshToken).toHaveBeenCalled();
  });

  it("removes top-level module imports when their root node is removed", () => {
    const removeImport = vi.fn(async () => ({ success: true }));
    const rendered = renderHookWithPdv(
      () =>
        useKernelSubscriptions({
          currentKernelId: "k1",
          loadedProjectTabsRef: { current: null },
          setCellTabs: vi.fn(),
          setActiveCellTab: vi.fn(),
          setLogs: vi.fn(),
          setModulesRefreshToken: vi.fn(),
          setProjectReloading: vi.fn(),
          setProgress: vi.fn(),
          onKernelCrash: vi.fn(),
          setKernelMemoryRss: vi.fn(),
        }),
      {
        pdvOverrides: {
          tree: {
            onChanged: vi.fn((cb: (payload: TreeChangedPayload) => void) => {
              queueMicrotask(() =>
                cb({ changed_paths: ["mymodule", "keep.child"], change_type: "removed" }),
              );
              return () => {};
            }),
          },
          modules: { removeImport },
        },
      },
    );

    return act(async () => {
      await Promise.resolve();
      expect(applyTreeChange).toHaveBeenCalledWith("k1", {
        changed_paths: ["mymodule", "keep.child"],
        change_type: "removed",
      });
      expect(removeImport).toHaveBeenCalledTimes(1);
      expect(removeImport).toHaveBeenCalledWith("mymodule");
      rendered.unmount();
    });
  });

  it("does not subscribe to tree changes without a kernel", () => {
    const { emitTreeChange } = renderSubscriptions([], null);
    act(() => {
      emitTreeChange({ changed_paths: ["a"], change_type: "added" });
    });
    expect(applyTreeChange).not.toHaveBeenCalled();
    expect(invalidateTree).not.toHaveBeenCalled();
  });
});
