import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, LogEntry } from '../types';

/** Options for {@link useKernelSubscriptions}. Manages push-subscription lifecycle. */
interface UseKernelSubscriptionsOptions {
  /** ID of the active kernel. Subscriptions are re-registered when this changes. */
  currentKernelId: string | null;
  /** Ref holding project-loaded tabs snapshot; consumed by the onLoaded handler. */
  loadedProjectTabsRef: MutableRefObject<{ tabs: CellTab[]; activeTabId: number } | null>;
  /** Setter for code cell tabs (updated on project load). */
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  /** Setter for active tab ID (updated on project load). */
  setActiveCellTab: Dispatch<SetStateAction<number>>;
  /** Appends streamed execution output (stdout, stderr, images) to console logs. */
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  /** Bumps the token to trigger Tree panel refetch on tree.changed pushes. */
  setTreeRefreshToken: Dispatch<SetStateAction<number>>;
  /** Bumps the token to trigger ModulesPanel refetch on tree changes. */
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
      // Keep module controls that depend on tree-backed options in sync.
      setModulesRefreshToken((prev) => prev + 1);
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
