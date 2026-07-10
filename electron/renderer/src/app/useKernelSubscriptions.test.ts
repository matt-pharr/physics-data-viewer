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

type LogsUpdate = LogEntry[] | ((prev: LogEntry[]) => LogEntry[]);

function renderSubscriptions(initialLogs: LogEntry[]) {
  let logs = initialLogs;
  const setLogs = vi.fn((update: LogsUpdate) => {
    logs = typeof update === "function" ? update(logs) : update;
  });
  let outputCallback: ((chunk: ExecuteOutputChunk) => void) | undefined;
  const rendered = renderHookWithPdv(
    () =>
      useKernelSubscriptions({
        currentKernelId: null,
        loadedProjectTabsRef: { current: null },
        setCellTabs: vi.fn(),
        setActiveCellTab: vi.fn(),
        setLogs,
        setTreeRefreshToken: vi.fn(),
        setModulesRefreshToken: vi.fn(),
        setProjectReloading: vi.fn(),
        setProgress: vi.fn(),
        onKernelCrash: vi.fn(),
        onTreeChanged: vi.fn(),
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
      },
    },
  );
  return {
    ...rendered,
    setLogs,
    getLogs: () => logs,
    emitChunk: (chunk: ExecuteOutputChunk) => outputCallback?.(chunk),
  };
}

beforeEach(() => {
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
    const other: LogEntry = { id: "exec-0", timestamp: 0, stdout: "done" };
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
