import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, Config, MenuActionPayload } from '../types';
import { normalizeRecentProjects } from './app-utils';
import { MAX_RECENT_PROJECTS } from './constants';

interface UnsavedDialogContext {
  reason: 'close' | 'open';
  pendingPath?: string;
}

/** Options for {@link useProjectWorkflow}. Orchestrates save/load/new project flows. */
interface UseProjectWorkflowOptions {
  /** Current kernel status — project operations require 'ready'. */
  kernelStatus: 'idle' | 'starting' | 'ready' | 'error';
  /** Path to the currently open project directory, or null for unsaved sessions. */
  currentProjectDir: string | null;
  /** Current code cell tabs (serialized into code-cells.json on save). */
  cellTabs: CellTab[];
  /** ID of the currently active editor tab. */
  activeCellTab: number;
  /** App configuration (read for recentProjects, updated after save/load). */
  config: Config | null;
  /** Persists updated recentProjects list after save/load. */
  setConfig: Dispatch<SetStateAction<Config | null>>;
  /** Updates the active project directory path. */
  setCurrentProjectDir: Dispatch<SetStateAction<string | null>>;
  /** Restores code cell tabs from project's code-cells.json on load. */
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  /** Restores the active tab ID on project load. */
  setActiveCellTab: Dispatch<SetStateAction<number>>;
  /** Bumps to trigger ModulesPanel refetch after project load. */
  setModulesRefreshToken: Dispatch<SetStateAction<number>>;
  /** Bumps to trigger NamespaceView refetch after project load. */
  setNamespaceRefreshToken: Dispatch<SetStateAction<number>>;
  /** Sets error message if save/load fails. */
  setLastError: Dispatch<SetStateAction<string | undefined>>;
  /** Ref holding the tabs snapshot from project.onLoaded push (consumed once). */
  loadedProjectTabsRef: MutableRefObject<{ tabs: CellTab[]; activeTabId: number } | null>;
  /** Validates and normalizes raw code-cells.json data into typed CellTab[]. */
  normalizeLoadedCodeCells: (data: unknown) => { tabs: CellTab[]; activeTabId: number };
  /** Flush all dirty markdown notes to disk before project save. */
  flushDirtyNotes: () => Promise<void>;
}

export function useProjectWorkflow(options: UseProjectWorkflowOptions) {
  const {
    kernelStatus,
    currentProjectDir,
    cellTabs,
    activeCellTab,
    config,
    setConfig,
    setCurrentProjectDir,
    setCellTabs,
    setActiveCellTab,
    setModulesRefreshToken,
    setNamespaceRefreshToken,
    setLastError,
    loadedProjectTabsRef,
    normalizeLoadedCodeCells,
    flushDirtyNotes,
  } = options;

  const [unsavedDialogContext, setUnsavedDialogContext] = useState<UnsavedDialogContext | null>(null);

  const rememberRecentProject = useCallback(async (projectDir: string) => {
    const recentProjects = normalizeRecentProjects(config?.recentProjects);
    const nextRecentProjects = [projectDir, ...recentProjects.filter((entry) => entry !== projectDir)].slice(0, MAX_RECENT_PROJECTS);
    try {
      const updated = await window.pdv.config.set({ recentProjects: nextRecentProjects });
      setConfig(updated);
    } catch {
      setConfig((prev) => (prev ? { ...prev, recentProjects: nextRecentProjects } : prev));
    }
    if (window.pdv?.menu) {
      await window.pdv.menu.updateRecentProjects(nextRecentProjects);
    }
  }, [config, setConfig]);

  const handleSaveProject = useCallback(async (options?: { saveAs?: boolean; directory?: string }): Promise<boolean> => {
    if (kernelStatus !== 'ready') {
      return false;
    }
    try {
      let saveDir = options?.directory ?? null;
      if (!saveDir) {
        if (options?.saveAs || !currentProjectDir) {
          saveDir = await window.pdv.files.pickDirectory();
        } else {
          saveDir = currentProjectDir;
        }
      }
      if (!saveDir) {
        return false;
      }
      await flushDirtyNotes();
      await window.pdv.project.save(saveDir, {
        tabs: cellTabs,
        activeTabId: activeCellTab,
      });
      setCurrentProjectDir(saveDir);
      setModulesRefreshToken((prev) => prev + 1);
      await rememberRecentProject(saveDir);
      return true;
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [
    activeCellTab,
    cellTabs,
    currentProjectDir,
    flushDirtyNotes,
    kernelStatus,
    rememberRecentProject,
    setCurrentProjectDir,
    setLastError,
    setModulesRefreshToken,
  ]);

  const executeOpenProject = useCallback(async (directory?: string) => {
    if (kernelStatus !== 'ready') {
      return;
    }
    try {
      const saveDir = directory ?? await window.pdv.files.pickDirectory();
      if (!saveDir) {
        return;
      }
      const loaded = await window.pdv.project.load(saveDir);
      const normalized = normalizeLoadedCodeCells(loaded);
      loadedProjectTabsRef.current = normalized;
      setCellTabs(normalized.tabs);
      setActiveCellTab(normalized.activeTabId);
      setCurrentProjectDir(saveDir);
      setModulesRefreshToken((prev) => prev + 1);
      await rememberRecentProject(saveDir);
      setNamespaceRefreshToken((prev) => prev + 1);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [
    kernelStatus,
    loadedProjectTabsRef,
    normalizeLoadedCodeCells,
    rememberRecentProject,
    setActiveCellTab,
    setCellTabs,
    setCurrentProjectDir,
    setLastError,
    setModulesRefreshToken,
    setNamespaceRefreshToken,
  ]);

  const handleOpenProject = useCallback((directory?: string) => {
    setUnsavedDialogContext({ reason: 'open', pendingPath: directory });
  }, []);

  const handleUnsavedSave = useCallback(async () => {
    const ctx = unsavedDialogContext;
    setUnsavedDialogContext(null);
    const saved = await handleSaveProject();
    if (ctx?.reason === 'close') {
      await window.pdv.lifecycle.respondClose({ action: saved ? 'save' : 'cancel' });
    } else if (ctx?.reason === 'open' && saved) {
      await executeOpenProject(ctx.pendingPath);
    }
  }, [unsavedDialogContext, handleSaveProject, executeOpenProject]);

  const handleUnsavedDiscard = useCallback(async () => {
    const ctx = unsavedDialogContext;
    setUnsavedDialogContext(null);
    if (ctx?.reason === 'close') {
      await window.pdv.lifecycle.respondClose({ action: 'discard' });
    } else if (ctx?.reason === 'open') {
      await executeOpenProject(ctx.pendingPath);
    }
  }, [unsavedDialogContext, executeOpenProject]);

  const handleUnsavedCancel = useCallback(async () => {
    const ctx = unsavedDialogContext;
    setUnsavedDialogContext(null);
    if (ctx?.reason === 'close') {
      await window.pdv.lifecycle.respondClose({ action: 'cancel' });
    }
  }, [unsavedDialogContext]);

  useEffect(() => {
    if (!window.pdv?.lifecycle) {
      return;
    }
    const unsubscribe = window.pdv.lifecycle.onConfirmClose(() => {
      setUnsavedDialogContext({ reason: 'close' });
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!window.pdv?.menu) {
      return;
    }
    const unsubscribe = window.pdv.menu.onAction((payload: MenuActionPayload) => {
      if (payload.action === 'project:open') {
        void handleOpenProject();
        return;
      }
      if (payload.action === 'project:openRecent') {
        if (payload.path) {
          void handleOpenProject(payload.path);
        }
        return;
      }
      if (payload.action === 'project:save') {
        void handleSaveProject();
        return;
      }
      if (payload.action === 'project:saveAs') {
        void handleSaveProject({ saveAs: true });
      }
    });
    return () => unsubscribe();
  }, [handleOpenProject, handleSaveProject]);

  return {
    unsavedDialogContext,
    handleSaveProject,
    handleOpenProject,
    handleUnsavedSave,
    handleUnsavedDiscard,
    handleUnsavedCancel,
  };
}
