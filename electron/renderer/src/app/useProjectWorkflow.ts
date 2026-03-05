import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, Config, MenuActionPayload } from '../types';

interface UnsavedDialogContext {
  reason: 'close' | 'open';
  pendingPath?: string;
}

interface UseProjectWorkflowOptions {
  kernelStatus: 'idle' | 'starting' | 'ready' | 'error';
  currentProjectDir: string | null;
  cellTabs: CellTab[];
  activeCellTab: number;
  config: Config | null;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  setCurrentProjectDir: Dispatch<SetStateAction<string | null>>;
  setCellTabs: Dispatch<SetStateAction<CellTab[]>>;
  setActiveCellTab: Dispatch<SetStateAction<number>>;
  setModulesRefreshToken: Dispatch<SetStateAction<number>>;
  setNamespaceRefreshToken: Dispatch<SetStateAction<number>>;
  setLastError: Dispatch<SetStateAction<string | undefined>>;
  loadedProjectTabsRef: MutableRefObject<{ tabs: CellTab[]; activeTabId: number } | null>;
  normalizeLoadedCodeCells: (data: unknown) => { tabs: CellTab[]; activeTabId: number };
}

function normalizeRecentProjects(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const unique = new Set<string>();
  const next: string[] = [];
  for (const entry of data) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || unique.has(trimmed)) continue;
    unique.add(trimmed);
    next.push(trimmed);
    if (next.length >= 10) break;
  }
  return next;
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
  } = options;

  const [unsavedDialogContext, setUnsavedDialogContext] = useState<UnsavedDialogContext | null>(null);

  const rememberRecentProject = useCallback(async (projectDir: string) => {
    const recentProjects = normalizeRecentProjects(config?.recentProjects);
    const nextRecentProjects = [projectDir, ...recentProjects.filter((entry) => entry !== projectDir)].slice(0, 10);
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
