// @vitest-environment jsdom

/**
 * useCodeCellsPersistence.test.ts — Unit tests for the debounced code-cell
 * autosave hook.
 *
 * Covers: debounce coalescing of rapid changes (regression: the effect
 * cleanup used to fire an immediate save on every dep change, i.e. an IPC
 * + disk write per keystroke), no-op when kernel is null, flush-on-unmount
 * when the kernel is alive with a pending edit, and no flush when the
 * kernel was already null at unmount.
 */

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHookWithPdv } from "../test-fixtures/hook-helpers";
import type { CellTab } from "../types";
import { useCodeCellsPersistence } from "./useCodeCellsPersistence";
import { CODE_CELL_SAVE_DEBOUNCE_MS } from "./constants";

const initialTabs: CellTab[] = [{ id: 1, code: "print(1)" }];

interface Props {
  cellTabs: CellTab[];
  activeCellTab: number;
  currentKernelId: string | null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCodeCellsPersistence", () => {
  it("does nothing when currentKernelId is null", () => {
    const { pdv } = renderHookWithPdv<void, Props>(
      (p) => useCodeCellsPersistence(p),
      {
        initialProps: {
          cellTabs: initialTabs,
          activeCellTab: 1,
          currentKernelId: null,
        },
      },
    );
    act(() => {
      vi.advanceTimersByTime(CODE_CELL_SAVE_DEBOUNCE_MS + 50);
    });
    expect(pdv.codeCells.save).not.toHaveBeenCalled();
  });

  it("coalesces rapid changes into a single save with the latest content", async () => {
    // Regression: the cleanup used to fire an immediate save on every dep
    // change, so typing produced one IPC + disk write per keystroke with
    // one-keystroke-stale content. Rapid edits must coalesce into exactly
    // one save after the debounce window, carrying the newest tabs.
    const { rerender, pdv } = renderHookWithPdv<void, Props>(
      (p) => useCodeCellsPersistence(p),
      {
        initialProps: {
          cellTabs: initialTabs,
          activeCellTab: 1,
          currentKernelId: "k1",
        },
      },
    );

    rerender({
      cellTabs: [{ id: 1, code: "print(2)" }],
      activeCellTab: 1,
      currentKernelId: "k1",
    });
    rerender({
      cellTabs: [{ id: 1, code: "print(3)" }],
      activeCellTab: 1,
      currentKernelId: "k1",
    });

    // Nothing has been written yet — the debounce is still pending.
    expect(pdv.codeCells.save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODE_CELL_SAVE_DEBOUNCE_MS);
    });

    // Exactly one save, with the latest tabs.
    expect(pdv.codeCells.save).toHaveBeenCalledTimes(1);
    expect(pdv.codeCells.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabs: [{ id: 1, code: "print(3)" }],
        activeTabId: 1,
      }),
    );

    // And the debounce stays quiet afterwards — no trailing writes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODE_CELL_SAVE_DEBOUNCE_MS * 3);
    });
    expect(pdv.codeCells.save).toHaveBeenCalledTimes(1);
  });

  it("on unmount, flushes the pending save when the kernel is still alive", () => {
    const { unmount, pdv } = renderHookWithPdv<void, Props>(
      (p) => useCodeCellsPersistence(p),
      {
        initialProps: {
          cellTabs: initialTabs,
          activeCellTab: 1,
          currentKernelId: "k1",
        },
      },
    );
    // Don't advance the timer — the cleanup runs while a save is still pending.
    unmount();
    expect(pdv.codeCells.save).toHaveBeenCalledTimes(1);
  });

  it("on unmount, does NOT flush when the kernel had already gone null", () => {
    const { rerender, unmount, pdv } = renderHookWithPdv<void, Props>(
      (p) => useCodeCellsPersistence(p),
      {
        initialProps: {
          cellTabs: initialTabs,
          activeCellTab: 1,
          currentKernelId: "k1",
        },
      },
    );
    // Move to kernel-null and let the cleanup-from-the-previous-effect (which
    // saw kernel=k1) run. That cleanup IS allowed to flush.
    rerender({
      cellTabs: initialTabs,
      activeCellTab: 1,
      currentKernelId: null,
    });
    expect(pdv.codeCells.save).toHaveBeenCalledTimes(1);
    (pdv.codeCells.save as ReturnType<typeof vi.fn>).mockClear();
    // Now unmount: the only effect is the no-kernel one, which never set up a
    // timer or save callback. Nothing further fires.
    unmount();
    expect(pdv.codeCells.save).not.toHaveBeenCalled();
  });
});
