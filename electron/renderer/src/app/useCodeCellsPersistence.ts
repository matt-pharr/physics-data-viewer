import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { CellTab } from '../types';
import { CODE_CELL_SAVE_DEBOUNCE_MS } from './constants';

/** Options for {@link useCodeCellsPersistence}. Reads/writes code cell state to ~/.PDV/state/. */
interface UseCodeCellsPersistenceOptions {
  /** The current array of code editor tabs (code, title, id). */
  cellTabs: CellTab[];
  /** The ID of the currently active editor tab. */
  activeCellTab: number;
  /** Setter to restore persisted tabs on mount. */
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  /** Setter to restore the persisted active tab on mount. */
  setActiveCellTab: Dispatch<SetStateAction<number>>;
  /** Current project directory — cells are only persisted/restored when a project is open. */
  currentProjectDir: string | null;
}

export function useCodeCellsPersistence({
  cellTabs,
  activeCellTab,
  setCellTabs,
  setActiveCellTab,
  currentProjectDir,
}: UseCodeCellsPersistenceOptions): void {
  const hasProjectRef = useRef(currentProjectDir);
  useEffect(() => {
    hasProjectRef.current = currentProjectDir;
  });

  useEffect(() => {
    if (!window.pdv?.codeCells || !currentProjectDir) {
      return;
    }
    const loadCodeCells = async () => {
      try {
        const data = await window.pdv.codeCells.load();
        if (data) {
          setCellTabs(data.tabs);
          setActiveCellTab(data.activeTabId);
        }
      } catch (error) {
        console.error('[App] Failed to load code cells:', error);
      }
    };
    void loadCodeCells();
  }, [setActiveCellTab, setCellTabs, currentProjectDir]);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!window.pdv?.codeCells || !currentProjectDir) {
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
        if (hasProjectRef.current) {
          void window.pdv.codeCells.save({
            tabs: cellTabs,
            activeTabId: activeCellTab,
          });
        }
      }
    };
  }, [activeCellTab, cellTabs, currentProjectDir]);
}
