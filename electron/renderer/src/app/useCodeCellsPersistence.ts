import { useEffect, useRef } from 'react';
import type { CellTab } from '../types';
import { CODE_CELL_SAVE_DEBOUNCE_MS } from './constants';

/**
 * Options for {@link useCodeCellsPersistence}.
 *
 * Writes the current code-cell tab state to the active kernel's working
 * directory (``<workingDir>/code-cells.json``) on a debounce. Cells are
 * scoped to the kernel lifetime: a fresh kernel starts with an empty tab
 * set, and project load restores tabs via {@link useProjectWorkflow}, not
 * via this hook. There is no global ``~/.PDV/state/`` persistence.
 */
interface UseCodeCellsPersistenceOptions {
  /** The current array of code editor tabs (code, title, id). */
  cellTabs: CellTab[];
  /** The ID of the currently active editor tab. */
  activeCellTab: number;
  /** Active kernel ID — autosave is disabled until a kernel is running. */
  currentKernelId: string | null;
}

export function useCodeCellsPersistence({
  cellTabs,
  activeCellTab,
  currentKernelId,
}: UseCodeCellsPersistenceOptions): void {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while an edit is scheduled but not yet written. Lets the
  // kernel-change/unmount flush below know whether there is anything to
  // persist without re-running on every keystroke.
  const pendingRef = useRef(false);
  const latestRef = useRef({ cellTabs, activeCellTab });
  useEffect(() => {
    latestRef.current = { cellTabs, activeCellTab };
  });

  // Debounced save. The cleanup ONLY cancels the pending timer — it must
  // not write. `cellTabs` changes on every keystroke, so a cleanup that
  // saves (as this hook once did) degrades into an IPC + disk write per
  // keystroke with one-keystroke-stale content.
  useEffect(() => {
    if (!window.pdv?.codeCells || !currentKernelId) {
      return;
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    pendingRef.current = true;
    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = null;
      pendingRef.current = false;
      try {
        await window.pdv.codeCells.save({
          tabs: cellTabs,
          activeTabId: activeCellTab,
        });
      } catch (error) {
        console.error('[App] Failed to save code cells:', error);
      }
    }, CODE_CELL_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [activeCellTab, cellTabs, currentKernelId]);

  // Flush on true unmount or kernel change only. Keyed on the kernel id
  // alone, so it does NOT re-run per edit; it reads the newest tab state
  // from `latestRef`. This cleanup runs after the debounce cleanup above
  // (declaration order), which has already cancelled the timer but left
  // `pendingRef` set.
  useEffect(() => {
    if (!window.pdv?.codeCells || !currentKernelId) {
      return;
    }
    return () => {
      if (pendingRef.current) {
        pendingRef.current = false;
        void window.pdv.codeCells.save({
          tabs: latestRef.current.cellTabs,
          activeTabId: latestRef.current.activeCellTab,
        });
      }
    };
  }, [currentKernelId]);
}
