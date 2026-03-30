import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CellTab, Config, LogEntry, MenuActionPayload } from '../types';
import type { ProgressPayload } from '../types/pdv';
import { normalizeRecentProjects } from './app-utils';
import { MAX_RECENT_PROJECTS } from './constants';

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
  /** Clears or updates save/load progress state. */
  setProgress: Dispatch<SetStateAction<ProgressPayload | null>>;
  /** Sets error message if save/load fails. */
  setLastError: Dispatch<SetStateAction<string | undefined>>;
  /** Appends entries to the console log. */
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
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
    setProgress,
    setLastError,
    setLogs,
    loadedProjectTabsRef,
    normalizeLoadedCodeCells,
    flushDirtyNotes,
  } = options;

  // Refs so handleSaveProject always reads the latest cell state, even when
  // called from memoised callbacks.
  const cellTabsRef = useRef(cellTabs);
  useEffect(() => { cellTabsRef.current = cellTabs; }, [cellTabs]);
  const activeCellTabRef = useRef(activeCellTab);
  useEffect(() => { activeCellTabRef.current = activeCellTab; }, [activeCellTab]);

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
      const result = await window.pdv.project.save(saveDir, {
        tabs: cellTabsRef.current,
        activeTabId: activeCellTabRef.current,
      });
      setCurrentProjectDir(saveDir);
      setModulesRefreshToken((prev) => prev + 1);
      await rememberRecentProject(saveDir);
      setLogs((prev) => [...prev, {
        id: `save-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: `Project saved (${result.nodeCount} nodes, checksum ${result.checksum})`,
      }]);
      return true;
    } catch (error) {
      setProgress(null);
      setLastError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [
    currentProjectDir,
    flushDirtyNotes,
    kernelStatus,
    rememberRecentProject,
    setCurrentProjectDir,
    setProgress,
    setLastError,
    setLogs,
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
      const result = await window.pdv.project.load(saveDir);
      const normalized = normalizeLoadedCodeCells(result.codeCells);
      loadedProjectTabsRef.current = normalized;
      setCellTabs(normalized.tabs);
      setActiveCellTab(normalized.activeTabId);
      setCurrentProjectDir(saveDir);
      setModulesRefreshToken((prev) => prev + 1);
      await rememberRecentProject(saveDir);
      setNamespaceRefreshToken((prev) => prev + 1);
      const parts = [`Project loaded`];
      if (result.nodeCount != null) parts.push(`${result.nodeCount} nodes`);
      if (result.checksum) {
        parts.push(`checksum ${result.checksum}`);
        if (result.checksumValid === false) parts.push('(MISMATCH)');
      }
      setLogs((prev) => [...prev, {
        id: `load-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0],
        ...(result.checksumValid === false ? { stderr: 'Warning: tree-index.json checksum does not match the stored checksum' } : {}),
      }]);
    } catch (error) {
      setProgress(null);
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
    setProgress,
    setLastError,
    setLogs,
    setModulesRefreshToken,
    setNamespaceRefreshToken,
  ]);

  const handleOpenProject = useCallback((directory?: string) => {
    void executeOpenProject(directory);
  }, [executeOpenProject]);

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
    handleSaveProject,
    handleOpenProject,
    executeOpenProject,
  };
}
