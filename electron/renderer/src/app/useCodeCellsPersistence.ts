import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { CellTab } from '../types';

interface UseCodeCellsPersistenceOptions {
  cellTabs: CellTab[];
  activeCellTab: number;
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  setActiveCellTab: Dispatch<SetStateAction<number>>;
}

export function useCodeCellsPersistence({
  cellTabs,
  activeCellTab,
  setCellTabs,
  setActiveCellTab,
}: UseCodeCellsPersistenceOptions): void {
  useEffect(() => {
    if (!window.pdv?.codeCells) {
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
  }, [setActiveCellTab, setCellTabs]);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!window.pdv?.codeCells) {
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
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        void window.pdv.codeCells.save({
          tabs: cellTabs,
          activeTabId: activeCellTab,
        });
      }
    };
  }, [activeCellTab, cellTabs]);
}
