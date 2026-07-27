/**
 * app/useWelcomeState.ts — Welcome-screen state and self-contained handlers.
 *
 * Owns the welcome overlay visibility flags (`showWelcome` for the pristine
 * first-run overlay, `forceWelcome` for explicit returns to the welcome
 * screen), the recent-project list enriched with manifest metadata, and the
 * recoverable orphaned-autosave session list with its refresh triggers.
 * Also owns the self-contained Clear Recents and Discard Session handlers.
 *
 * Does NOT orchestrate kernel startup or project opening/recovery — those
 * flows (openProjectFromWelcome, handleRecoverSession, the welcome
 * new-project handlers, …) stay in App and call back into `dismissWelcome`
 * and `refreshRecoverableSessions` as needed.
 */

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { RecentProject, RecoverableSession } from '../components/WelcomeScreen';
import type { Config } from '../types';
import { normalizeRecentProjects } from './app-utils';

/** Options for {@link useWelcomeState}. All setters correspond to App-level useState. */
interface UseWelcomeStateOptions {
  /** App configuration — `recentProjects` feeds the recent-project list. */
  config: Config | null;
  /** Persists the cleared recent-project list after Clear Recents. */
  setConfig: Dispatch<SetStateAction<Config | null>>;
  /** Kernel status — recoverable sessions are re-scanned when it reaches 'ready'. */
  kernelStatus: 'idle' | 'starting' | 'ready' | 'error';
  /** Sets the error banner when discarding an orphaned session fails. */
  setLastError: Dispatch<SetStateAction<string | undefined>>;
}

export function useWelcomeState(options: UseWelcomeStateOptions) {
  const { config, setConfig, kernelStatus, setLastError } = options;

  // -- Welcome screen (pristine session) ------------------------------------

  const [showWelcome, setShowWelcome] = useState(true);
  const [forceWelcome, setForceWelcome] = useState(false);

  const recentProjectEntries = useMemo(
    () => normalizeRecentProjects(config?.recentProjects),
    [config?.recentProjects],
  );

  /** Build RecentProject[] with language and name metadata from project.json files. */
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  useEffect(() => {
    if (recentProjectEntries.length === 0) {
      setRecentProjects([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      recentProjectEntries.map(async (entry) => {
        // Only this machine's projects can be inspected from here; a remote
        // entry's manifest lives on its host and is read after connecting.
        if (entry.host !== null) {
          return { path: entry.path, host: entry.host } as RecentProject;
        }
        try {
          const peek = await window.pdv.project.peekManifest(entry.path);
          return {
            path: entry.path,
            host: null,
            language: peek.language,
            name: peek.projectName,
          } as RecentProject;
        } catch {
          return { path: entry.path, host: null } as RecentProject;
        }
      })
    ).then((results) => {
      if (!cancelled) setRecentProjects(results);
    });
    return () => { cancelled = true; };
  }, [recentProjectEntries]);

  // Orphaned autosaves available on the welcome screen. Refreshed on mount,
  // again when the kernel becomes ready (in case scan races with kernel start),
  // and after each Recover/Discard.
  const [recoverableSessions, setRecoverableSessions] = useState<RecoverableSession[]>([]);
  const refreshRecoverableSessions = useCallback(async () => {
    try {
      const sessions = await window.pdv.autosave.scanWorkingDirs();
      setRecoverableSessions(sessions);
    } catch (error) {
      console.warn('[app] scanWorkingDirs failed', error);
      setRecoverableSessions([]);
    }
  }, []);
  useEffect(() => {
    void refreshRecoverableSessions();
  }, [refreshRecoverableSessions]);
  useEffect(() => {
    if (kernelStatus === 'ready') {
      void refreshRecoverableSessions();
    }
  }, [kernelStatus, refreshRecoverableSessions]);

  const dismissWelcome = useCallback(() => {
    setShowWelcome(false);
    setForceWelcome(false);
  }, []);

  const handleDiscardSession = useCallback(async (orphanDir: string) => {
    try {
      await window.pdv.autosave.deleteOrphan(orphanDir);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      void refreshRecoverableSessions();
    }
  }, [setLastError, refreshRecoverableSessions]);

  // Shared between the WelcomeScreen "Clear" button and the native
  // File → Clear Menu action (see App's menu-action useEffect).
  const handleClearRecents = useCallback(() => {
    void window.pdv.config.set({ recentProjects: [] }).then((updated) => {
      if (updated) setConfig((prev) => (prev ? { ...prev, recentProjects: [] } : prev));
    });
    void window.pdv.menu.updateRecentProjects([]);
  }, [setConfig]);

  return {
    showWelcome,
    forceWelcome,
    setForceWelcome,
    dismissWelcome,
    recentProjects,
    recoverableSessions,
    refreshRecoverableSessions,
    handleClearRecents,
    handleDiscardSession,
  };
}
