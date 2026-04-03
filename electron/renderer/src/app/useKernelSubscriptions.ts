import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, LogEntry, TreeChangeInfo } from '../types';
import type { ProgressPayload } from '../types/pdv';

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
  /** Bumps the token to trigger Tree panel full refetch (project load, reload, etc.). */
  setTreeRefreshToken: Dispatch<SetStateAction<number>>;
  /** Bumps the token to trigger ModulesPanel refetch on tree changes. */
  setModulesRefreshToken: Dispatch<SetStateAction<number>>;
  /** Controls the project-reloading overlay shown during kernel restart with active project. */
  setProjectReloading: Dispatch<SetStateAction<boolean>>;
  /** Updates the progress state for save/load operations. */
  setProgress: Dispatch<SetStateAction<ProgressPayload | null>>;
  /** Called when a kernel crash is detected via the push channel. */
  onKernelCrash: (kernelId: string) => void;
  /** Called on incremental tree changes so the Tree can update selectively. */
  onTreeChanged: (info: TreeChangeInfo) => void;
}

export function useKernelSubscriptions({
  currentKernelId,
  loadedProjectTabsRef,
  setCellTabs,
  setActiveCellTab,
  setLogs,
  setTreeRefreshToken,
  setModulesRefreshToken,
  setProjectReloading,
  setProgress,
  onKernelCrash,
  onTreeChanged,
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
      // Notify Tree for selective (incremental) update instead of a full reload.
      onTreeChanged({
        changed_paths: payload.changed_paths,
        change_type: payload.change_type,
      });
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

    const unsubscribeKernelStatus = window.pdv.kernels.onKernelStatus((payload) => {
      if (payload.status === "dead") {
        onKernelCrash(payload.kernelId);
      }
    });

    const unsubscribeProgress = window.pdv.progress.onProgress((payload) => {
      if (payload.current >= payload.total) {
        // Clear after a short delay so the bar visually reaches 100%
        setTimeout(() => setProgress(null), 400);
      } else {
        setProgress(payload);
      }
    });

    const unsubscribeReloading = window.pdv.project.onReloading((payload) => {
      if (payload.status === 'reloading') {
        setProjectReloading(true);
      } else if (payload.status === 'ready') {
        setProjectReloading(false);
        setTreeRefreshToken((prev) => prev + 1);
        setModulesRefreshToken((prev) => prev + 1);
      }
    });

    return () => {
      unsubscribeTree();
      unsubscribeProject();
      unsubscribeKernelStatus();
      unsubscribeProgress();
      unsubscribeReloading();
    };
  }, [
    currentKernelId,
    loadedProjectTabsRef,
    onKernelCrash,
    setActiveCellTab,
    setCellTabs,
    setModulesRefreshToken,
    setProgress,
    setProjectReloading,
    setTreeRefreshToken,
    onTreeChanged,
  ]);
}
