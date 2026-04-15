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
  const hasKernelRef = useRef(currentKernelId);
  useEffect(() => {
    hasKernelRef.current = currentKernelId;
  });

  useEffect(() => {
    if (!window.pdv?.codeCells || !currentKernelId) {
      return;
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
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
        if (hasKernelRef.current) {
          void window.pdv.codeCells.save({
            tabs: cellTabs,
            activeTabId: activeCellTab,
          });
        }
      }
    };
  }, [activeCellTab, cellTabs, currentKernelId]);
}
