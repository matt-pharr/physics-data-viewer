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
  /** Updates the short checksum shown in the status bar (first 6 hex chars). */
  setLastChecksum: Dispatch<SetStateAction<string | null>>;
  /** Sets whether the last load produced a checksum mismatch. */
  setChecksumMismatch: Dispatch<SetStateAction<boolean>>;
  /** Sets the PDV version the loaded project was saved with (for status bar warning). */
  setSavedPdvVersion: Dispatch<SetStateAction<string | null>>;
  /** Updates the project name displayed in the title bar. */
  setCurrentProjectName: Dispatch<SetStateAction<string | null>>;
  /** Shows or hides the Save As dialog. */
  setShowSaveAsDialog: Dispatch<SetStateAction<boolean>>;
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
    setLastChecksum,
    setChecksumMismatch,
    setSavedPdvVersion,
    setCurrentProjectName,
    setShowSaveAsDialog,
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

  const handleSaveProject = useCallback(async (options?: { saveAs?: boolean; directory?: string; projectName?: string }): Promise<boolean> => {
    if (kernelStatus !== 'ready') {
      return false;
    }
    // If Save As is requested or no project is open yet, show the SaveAs dialog
    // instead of the native directory picker.
    if (options?.saveAs || (!options?.directory && !currentProjectDir)) {
      setShowSaveAsDialog(true);
      // Returns false — not an error. The dialog will invoke handleSaveProject
      // again with { directory, projectName } once the user confirms.
      return false;
    }
    try {
      const saveDir = options?.directory ?? currentProjectDir;
      if (!saveDir) {
        return false;
      }
      await flushDirtyNotes();
      const result = await window.pdv.project.save(saveDir, {
        tabs: cellTabsRef.current,
        activeTabId: activeCellTabRef.current,
      }, options?.projectName);
      setCurrentProjectDir(saveDir);
      setCurrentProjectName(result.projectName ?? options?.projectName ?? null);
      setModulesRefreshToken((prev) => prev + 1);
      setLastChecksum(result.checksum.slice(0, 6));
      setChecksumMismatch(false);
      setSavedPdvVersion(null); // Just saved with current version — no mismatch
      await rememberRecentProject(saveDir);
      setLogs((prev) => [...prev, {
        id: `save-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: `Project saved (${result.nodeCount} nodes)`,
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
    setChecksumMismatch,
    setCurrentProjectDir,
    setCurrentProjectName,
    setLastChecksum,
    setProgress,
    setLastError,
    setLogs,
    setModulesRefreshToken,
    setSavedPdvVersion,
    setShowSaveAsDialog,
  ]);

  const executeOpenProject = useCallback(async (directory?: string) => {
    if (kernelStatus !== 'ready') {
      return;
    }
    try {
      // If no directory given, open a native picker starting at the parent of the current project.
      let pickedDir = directory;
      if (!pickedDir) {
        const defaultPath = currentProjectDir
          ? currentProjectDir.replace(/\/[^/]+\/?$/, '')
          : undefined;
        pickedDir = await window.pdv.files.pickDirectory(defaultPath) ?? undefined;
      }
      if (!pickedDir) {
        return;
      }
      const saveDir = pickedDir;
      const result = await window.pdv.project.load(saveDir);
      const normalized = normalizeLoadedCodeCells(result.codeCells);
      loadedProjectTabsRef.current = normalized;
      setCellTabs(normalized.tabs);
      setActiveCellTab(normalized.activeTabId);
      setCurrentProjectDir(saveDir);
      setCurrentProjectName(result.projectName ?? null);
      setModulesRefreshToken((prev) => prev + 1);
      await rememberRecentProject(saveDir);
      setNamespaceRefreshToken((prev) => prev + 1);
      setLastChecksum(result.checksum ? result.checksum.slice(0, 6) : null);
      setChecksumMismatch(result.checksumValid === false);
      setSavedPdvVersion(result.savedPdvVersion ?? null);
      const nodeCountMsg = result.nodeCount != null ? ` (${result.nodeCount} nodes)` : '';
      setLogs((prev) => [...prev, {
        id: `load-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: `Project loaded${nodeCountMsg}`,
      }]);
    } catch (error) {
      setProgress(null);
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [
    currentProjectDir,
    kernelStatus,
    loadedProjectTabsRef,
    normalizeLoadedCodeCells,
    rememberRecentProject,
    setActiveCellTab,
    setCellTabs,
    setChecksumMismatch,
    setCurrentProjectDir,
    setCurrentProjectName,
    setSavedPdvVersion,
    setLastChecksum,
    setProgress,
    setLastError,
    setLogs,
    setModulesRefreshToken,
    setNamespaceRefreshToken,
  ]);

  useEffect(() => {
    if (!window.pdv?.menu) {
      return;
    }
    const unsubscribe = window.pdv.menu.onAction((payload: MenuActionPayload) => {
      // project:open and project:openRecent are handled in App's menu listener
      // so they can route through openProjectFromWelcome when the kernel isn't ready.
      if (payload.action === 'project:save') {
        void handleSaveProject();
        return;
      }
      if (payload.action === 'project:saveAs') {
        void handleSaveProject({ saveAs: true });
      }
    });
    return () => unsubscribe();
  }, [handleSaveProject]);

  return {
    handleSaveProject,
    executeOpenProject,
  };
}
