import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, LogEntry, TreeChangeInfo } from '../types';
import type { ProgressPayload } from '../types/pdv';
import { MAX_LOG_ENTRIES } from './constants';

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
  /** Setter for the latest kernel-process RSS in bytes (null when unknown). */
  setKernelMemoryRss: Dispatch<SetStateAction<number | null>>;
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
  setKernelMemoryRss,
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

  // Main-initiated runs (MCP agent tools) push a `begin` event before the
  // first chunk so we can seed a log entry — without that, `onOutput`
  // chunks find no row to attach to and the Console stays empty for agent
  // activity. `finish` carries duration/error info that does not arrive
  // via streaming chunks. The renderer's own `kernels.execute` calls do
  // not emit these pushes; they seed their log entries locally.
  useEffect(() => {
    const offBegin = window.pdv.kernels.onExecuteBegin((payload) => {
      setLogs((prev) => {
        if (prev.some((l) => l.id === payload.executionId)) return prev;
        const next: LogEntry[] = [
          ...prev,
          {
            id: payload.executionId,
            timestamp: payload.timestamp,
            code: payload.code,
            origin: payload.origin,
          },
        ];
        return next.length > MAX_LOG_ENTRIES
          ? next.slice(next.length - MAX_LOG_ENTRIES)
          : next;
      });
    });
    const offFinish = window.pdv.kernels.onExecuteFinish((payload) => {
      setLogs((prev) =>
        prev.map((l) =>
          l.id === payload.executionId
            ? {
                ...l,
                duration: payload.duration,
                error: payload.error,
                errorDetails: payload.errorDetails,
              }
            : l,
        ),
      );
    });
    return () => {
      offBegin();
      offFinish();
    };
  }, [setLogs]);

  useEffect(() => {
    if (!currentKernelId) {
      return;
    }

    const unsubscribeTree = window.pdv.tree.onChanged((payload) => {
      // "unknown" comes from non-root PDVTree mutations (intermediate
      // sub-trees, scratch trees) where the local path can't be mapped to
      // the renderer's absolute view. Trigger a full refresh-with-expansion
      // instead of trying to reconcile changed_paths.
      if (payload.change_type === "unknown") {
        setTreeRefreshToken((prev) => prev + 1);
        setModulesRefreshToken((prev) => prev + 1);
        return;
      }
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

    const unsubscribeKernelCrashed = window.pdv.kernels.onKernelCrashed((payload) => {
      onKernelCrash(payload.kernelId);
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

    const unsubscribeReconnected = window.pdv.kernels.onReconnected(() => {
      setTreeRefreshToken((prev) => prev + 1);
      setModulesRefreshToken((prev) => prev + 1);
    });

    const unsubscribeMemory = window.pdv.kernels.onMemory((payload) => {
      if (payload.kernelId !== currentKernelId) return;
      setKernelMemoryRss(payload.rssBytes);
    });

    return () => {
      unsubscribeTree();
      unsubscribeProject();
      unsubscribeKernelCrashed();
      unsubscribeProgress();
      unsubscribeReloading();
      unsubscribeReconnected();
      unsubscribeMemory();
      // Clear the readout so a fresh kernel doesn't briefly show stale memory.
      setKernelMemoryRss(null);
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
    setKernelMemoryRss,
  ]);
}
