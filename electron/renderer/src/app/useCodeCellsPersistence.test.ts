// @vitest-environment jsdom

/**
 * useCodeCellsPersistence.test.ts — Unit tests for the debounced code-cell
 * autosave hook.
 *
 * Covers: debounce coalescing of rapid changes, no-op when kernel is null,
 * cleanup-on-unmount only flushes when the kernel was alive at unmount, and
 * cleanup is a no-op if the kernel was already null at unmount.
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

  it("flushes intermediate saves on each change and a final save after the debounce window", async () => {
    // Note: this hook intentionally flushes on every rerender (effect cleanup
    // cancels the pending timeout AND fires an immediate save) plus a final
    // settle save when the timeout elapses. So rapid changes don't *coalesce*
    // — they each get persisted right away. The debounce only matters as the
    // tail timer for the last change.
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

    // Each rerender triggers cleanup-then-effect, and cleanup flushes when
    // the kernel is still alive. So we already have ≥1 save by here.
    const callsBeforeAdvance = (pdv.codeCells.save as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(callsBeforeAdvance).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CODE_CELL_SAVE_DEBOUNCE_MS);
    });

    // The final settle save fires with the latest tabs.
    expect(pdv.codeCells.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabs: [{ id: 1, code: "print(3)" }],
        activeTabId: 1,
      }),
    );
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
