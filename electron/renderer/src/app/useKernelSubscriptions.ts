import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, LogEntry } from '../types';

interface UseKernelSubscriptionsOptions {
  currentKernelId: string | null;
  loadedProjectTabsRef: MutableRefObject<{ tabs: CellTab[]; activeTabId: number } | null>;
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  setActiveCellTab: Dispatch<SetStateAction<number>>;
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setTreeRefreshToken: Dispatch<SetStateAction<number>>;
  setModulesRefreshToken: Dispatch<SetStateAction<number>>;
}

export function useKernelSubscriptions({
  currentKernelId,
  loadedProjectTabsRef,
  setCellTabs,
  setActiveCellTab,
  setLogs,
  setTreeRefreshToken,
  setModulesRefreshToken,
}: UseKernelSubscriptionsOptions): void {
  useEffect(() => {
    const unsubscribe = window.pdv.kernels.onOutput((chunk) => {
      setLogs((prev) =>
        prev.map((l) => {
          if (l.id !== chunk.executionId) return l;
          if (chunk.type === 'stdout') return { ...l, stdout: (l.stdout ?? '') + chunk.text! };
          if (chunk.type === 'stderr') return { ...l, stderr: (l.stderr ?? '') + chunk.text! };
          if (chunk.type === 'image') return { ...l, images: [...(l.images ?? []), chunk.image!] };
          if (chunk.type === 'result') return { ...l, result: chunk.result };
          return l;
        })
      );
    });
    return unsubscribe;
  }, [setLogs]);

  useEffect(() => {
    if (!currentKernelId) {
      return;
    }

    const unsubscribeTree = window.pdv.tree.onChanged((payload) => {
      setTreeRefreshToken((prev) => prev + 1);
      if (payload.change_type === "removed" && payload.changed_paths.length > 0) {
        for (const removedPath of payload.changed_paths) {
          if (!removedPath.includes(".")) {
            void window.pdv.modules.removeImport(removedPath).then(() => {
              setModulesRefreshToken((prev) => prev + 1);
            });
          }
        }
      }
    });

    const unsubscribeProject = window.pdv.project.onLoaded(() => {
      if (loadedProjectTabsRef.current) {
        const loaded = loadedProjectTabsRef.current;
        setCellTabs(loaded.tabs);
        setActiveCellTab(loaded.activeTabId);
      }
      setTreeRefreshToken((prev) => prev + 1);
    });

    return () => {
      unsubscribeTree();
      unsubscribeProject();
    };
  }, [
    currentKernelId,
    loadedProjectTabsRef,
    setActiveCellTab,
    setCellTabs,
    setModulesRefreshToken,
    setTreeRefreshToken,
  ]);
}
