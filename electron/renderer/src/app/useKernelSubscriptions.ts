import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, LogEntry } from '../types';
import type { ExecuteOutputChunk, ProgressPayload } from '../types/pdv';
import { appendLogEntry } from './app-utils';
import {
  invalidateAllKernelState,
  applyTreeChange,
  invalidateCompletions,
  invalidateNamespace,
  invalidateTree,
} from '../queries/invalidation';

/**
 * How long buffered output chunks may sit before being applied to the log
 * state (one frame at 60 Hz). Long-running executions can stream hundreds of
 * chunks per second; applying each one individually re-renders the whole app
 * per chunk. Coalescing to one state update per interval keeps the console
 * visually live while bounding render work.
 */
const OUTPUT_FLUSH_INTERVAL_MS = 16;

/** Apply a batch of buffered output chunks to the log entries in one pass. */
function applyOutputChunks(prev: LogEntry[], chunks: ExecuteOutputChunk[]): LogEntry[] {
  return prev.map((l) => {
    let entry = l;
    for (const chunk of chunks) {
      if (entry.id !== chunk.executionId) continue;
      if (chunk.type === 'stdout') entry = { ...entry, stdout: (entry.stdout ?? '') + chunk.text! };
      else if (chunk.type === 'stderr') entry = { ...entry, stderr: (entry.stderr ?? '') + chunk.text! };
      else if (chunk.type === 'image') entry = { ...entry, images: [...(entry.images ?? []), chunk.image!] };
      else if (chunk.type === 'result') entry = { ...entry, result: chunk.result };
    }
    return entry;
  });
}

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
  /** Bumps the token to trigger ModulesPanel refetch on tree changes. */
  setModulesRefreshToken: Dispatch<SetStateAction<number>>;
  /** Controls the project-reloading overlay shown during kernel restart with active project. */
  setProjectReloading: Dispatch<SetStateAction<boolean>>;
  /** Updates the progress state for save/load operations. */
  setProgress: Dispatch<SetStateAction<ProgressPayload | null>>;
  /** Called when a kernel crash is detected via the push channel. */
  onKernelCrash: (kernelId: string) => void;
  /** Setter for the latest kernel-process RSS in bytes (null when unknown). */
  setKernelMemoryRss: Dispatch<SetStateAction<number | null>>;
}

export function useKernelSubscriptions({
  currentKernelId,
  loadedProjectTabsRef,
  setCellTabs,
  setActiveCellTab,
  setLogs,
  setModulesRefreshToken,
  setProjectReloading,
  setProgress,
  onKernelCrash,
  setKernelMemoryRss,
}: UseKernelSubscriptionsOptions): void {
  useEffect(() => {
    // Buffer chunks and flush at most once per OUTPUT_FLUSH_INTERVAL_MS. Each
    // IPC push arrives in its own task, so React cannot auto-batch them; a
    // per-chunk setLogs re-renders the app for every fragment of output.
    let pending: ExecuteOutputChunk[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      const chunks = pending;
      pending = [];
      setLogs((prev) => applyOutputChunks(prev, chunks));
    };

    const unsubscribe = window.pdv.kernels.onOutput((chunk) => {
      pending.push(chunk);
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, OUTPUT_FLUSH_INTERVAL_MS);
      }
    });
    return () => {
      unsubscribe();
      if (flushTimer !== null) clearTimeout(flushTimer);
      flush(); // don't drop buffered output when the subscription re-registers
    };
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
        return appendLogEntry(prev, {
          id: payload.executionId,
          timestamp: payload.timestamp,
          code: payload.code,
          origin: payload.origin,
        });
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
      // Agent-driven runs mutate kernel state just like renderer runs do,
      // but never pass through executeImmediate's finally block — refresh
      // the same caches here.
      if (currentKernelId) {
        invalidateTree(currentKernelId);
        invalidateNamespace(currentKernelId);
        invalidateCompletions(currentKernelId);
      }
    });
    return () => {
      offBegin();
      offFinish();
    };
  }, [setLogs, currentKernelId]);

  useEffect(() => {
    if (!currentKernelId) {
      return;
    }

    const unsubscribeTree = window.pdv.tree.onChanged((payload) => {
      // Targeted cache surgery: removals patch the parent listing in place
      // (0 round trips); adds/updates invalidate only the changed parents;
      // "unknown" (non-root PDVTree mutations whose local path can't be
      // mapped to the renderer's absolute view) invalidates every listing,
      // refetching visible levels in parallel.
      applyTreeChange(currentKernelId, {
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
      invalidateTree(currentKernelId);
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
        invalidateTree(currentKernelId);
        setModulesRefreshToken((prev) => prev + 1);
      }
    });

    const unsubscribeReconnected = window.pdv.kernels.onReconnected(() => {
      // Everything kernel-scoped, not just the tree: after a system wake the
      // namespace can have moved too, and refreshing only what is visible
      // leaves the rest quietly wrong until something else happens to
      // invalidate it.
      invalidateAllKernelState(currentKernelId, 'reconnect');
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
    setKernelMemoryRss,
  ]);
}
