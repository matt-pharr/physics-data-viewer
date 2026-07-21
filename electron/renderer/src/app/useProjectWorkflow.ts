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
  /** Opens the Save As dialog. */
  openSaveAsDialog: () => void;
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
    openSaveAsDialog,
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
    if (!options?.directory && (options?.saveAs || !currentProjectDir)) {
      openSaveAsDialog();
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

      // If backing files are missing the save was blocked to protect the
      // existing project directory.
      if (result.missingFiles?.length) {
        setLogs((prev) => [...prev, {
          id: `save-blocked-${Date.now()}`,
          timestamp: Date.now(),
          code: '',
          stderr: `Save blocked: ${result.missingFiles!.length} file-backed node(s) have missing backing files. These nodes must be removed from the tree or their files restored before saving:\n  ${result.missingFiles!.join('\n  ')}\nTo remove a node, right-click it in the Tree and choose Delete. If you'd rather discard in-memory changes and not lose data, reopen the project from disk (File > Open Project) to restore the last saved state.`,
        }]);
        return false;
      }

      setCurrentProjectDir(saveDir);
      setCurrentProjectName(result.projectName ?? options?.projectName ?? null);
      setModulesRefreshToken((prev) => prev + 1);
      setLastChecksum(result.checksum.slice(0, 6));
      setChecksumMismatch(false);
      setSavedPdvVersion(null); // Just saved with current version — no mismatch
      await rememberRecentProject(saveDir);

      // Nodes the kernel could not serialize: the save completed without
      // them, which must never look like a clean save. Preserved nodes kept
      // their previously saved value on disk; unpreserved ones are absent
      // from the save entirely.
      const failedWarn = result.failedNodes?.length
        ? `\nWarning: ${result.failedNodes.length} node(s) could not be serialized and were skipped:\n  ${result.failedNodes
            .map((f) => `${f.path ?? '?'} — ${f.error ?? 'unknown error'}${f.preserved ? ' (previous saved value kept)' : ' (NOT in this save)'}`)
            .join('\n  ')}`
        : '';
      setLogs((prev) => [...prev, {
        id: `save-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: `Project saved (${result.nodeCount} nodes)`,
        ...(failedWarn ? { stderr: failedWarn.trimStart() } : {}),
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
    openSaveAsDialog,
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

      // Check for autosave recovery before loading
      let restoreFromAutosave = false;
      const autosaveCheck = await window.pdv.autosave.check(saveDir);
      if (autosaveCheck.exists) {
        const when = autosaveCheck.timestamp
          ? new Date(autosaveCheck.timestamp).toLocaleString()
          : 'unknown time';
        restoreFromAutosave = window.confirm(
          `This project has autosaved changes from ${when} that were not explicitly saved.\n\nRestore autosaved changes?`
        );
        if (!restoreFromAutosave) {
          await window.pdv.autosave.clear(saveDir);
        }
      }

      const result = await window.pdv.project.load(saveDir, restoreFromAutosave ? { restoreFromAutosave: true } : undefined);
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
      // Clean up .autosave/ after a successful restore
      if (restoreFromAutosave) {
        await window.pdv.autosave.clear(saveDir);
      }

      const nodeCountMsg = result.nodeCount != null ? ` (${result.nodeCount} nodes)` : '';
      const restoredMsg = restoreFromAutosave ? ' (restored from autosave)' : '';
      const loadMissingWarn = result.missingFiles?.length
        ? `\nWarning: ${result.missingFiles.length} file(s) were missing from the save directory:\n  ${result.missingFiles.join('\n  ')}`
        : '';
      const envSyncWarn = result.envSyncWarning
        ? `\nWarning: ${result.envSyncWarning}`
        : '';
      setLogs((prev) => [...prev, {
        id: `load-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: `Project loaded${nodeCountMsg}${restoredMsg}${loadMissingWarn}${envSyncWarn}`,
      }]);

      // §10.7.5: the project's environment was resolved with a different
      // Julia minor than the session is running. Point at the installed
      // matching channel, or offer to acquire it with juliaup. The load
      // itself has already completed — this is advisory.
      const jv = result.juliaVersionCheck;
      if (jv) {
        const running = jv.runningVersion
          ? `Julia ${jv.runningVersion}`
          : 'a different Julia version';
        const resolvedWith =
          `This project's packages were resolved with Julia ${jv.manifestVersion}, `
          + `but this session is running ${running}`;
        if (jv.channelInstalled) {
          setLogs((prev) => [...prev, {
            id: `julia-version-${Date.now()}`,
            timestamp: Date.now(),
            code: '',
            stdout: `${resolvedWith}. juliaup channel ${jv.channel} is installed — `
              + 'select it under Settings → Runtime and restart the session to match.',
          }]);
        } else if (jv.juliaupInstalled) {
          const install = window.confirm(
            `${resolvedWith} and Julia ${jv.channel} is not installed.\n\n`
            + `Install Julia ${jv.channel} with juliaup now? Afterwards, select it `
            + 'under Settings → Runtime (and install PDVKernel into it) to use it '
            + 'for this project.'
          );
          if (install) {
            setLogs((prev) => [...prev, {
              id: `juliaup-add-start-${Date.now()}`,
              timestamp: Date.now(),
              code: '',
              stdout: `Installing Julia ${jv.channel} with juliaup...`,
            }]);
            void window.pdv.environment.juliaupAdd(jv.channel).then((res) => {
              setLogs((prev) => [...prev, {
                id: `juliaup-add-${Date.now()}`,
                timestamp: Date.now(),
                code: '',
                stdout: res.success
                  ? `Julia ${jv.channel} installed. Select it under Settings → Runtime `
                    + '(and install PDVKernel into it) to use it for this project.'
                  : `juliaup add ${jv.channel} failed:\n${res.output}`,
              }]);
            });
          }
        } else {
          setLogs((prev) => [...prev, {
            id: `julia-version-${Date.now()}`,
            timestamp: Date.now(),
            code: '',
            stdout: `${resolvedWith}, and Julia ${jv.channel} is not installed. `
              + 'Install juliaup (Settings → Runtime) to add it.',
          }]);
        }
      }
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
        void handleSaveProject(payload.path ? { directory: payload.path } : undefined);
        return;
      }
      if (payload.action === 'project:saveAs') {
        void handleSaveProject({ saveAs: true, directory: payload.path });
      }
    });
    return () => unsubscribe();
  }, [handleSaveProject]);

  return {
    handleSaveProject,
    executeOpenProject,
  };
}
