/**
 * app/index.tsx — Root renderer orchestration component.
 *
 * Responsibilities:
 * - Own kernel lifecycle from the renderer side (`window.pdv.kernels.*`)
 * - Coordinate tree/namespace refresh triggers from push subscriptions
 * - Manage code-cell tabs, console log state, and global dialogs
 * - Apply appearance/font settings from persisted config
 *
 * Does NOT perform filesystem or kernel transport work directly; those stay
 * behind the preload bridge (`window.pdv`) and main-process IPC handlers.
 */

import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { CodeCell } from '../components/CodeCell';
import { Console } from '../components/Console';
import { Tree } from '../components/Tree';
import { ActivityBar } from '../components/ActivityBar';
import { StatusBar } from '../components/StatusBar';

import { NamespaceView } from '../components/NamespaceView';
import { ScriptDialog } from '../components/ScriptDialog';
import { CreateScriptDialog } from '../components/Tree/CreateScriptDialog';
import { CreateLibDialog } from '../components/Tree/CreateLibDialog';
import { CreateGuiDialog } from '../components/Tree/CreateGuiDialog';
import { NewModuleDialog } from '../components/NewModuleDialog';
import { ModuleMetadataDialog } from '../components/ModuleMetadataDialog';
import { CreateNodeDialog } from '../components/Tree/CreateNodeDialog';
import { CreateNoteDialog } from '../components/Tree/CreateNoteDialog';
import { DuplicateDialog } from '../components/Tree/DuplicateDialog';
import { MoveDialog } from '../components/Tree/MoveDialog';
import { RenameDialog } from '../components/Tree/RenameDialog';
import { TitleBar } from '../components/TitleBar';
import { WriteTab } from '../components/WriteTab';
import { SettingsDialog } from '../components/SettingsDialog';
import { ImportModuleDialog } from '../components/ImportModuleDialog';
import { SaveAsDialog } from '../components/SaveAsDialog';
import { NewProjectDialog } from '../components/NewProjectDialog';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import { WelcomeScreen, type RecentProject, type RecoverableSession } from '../components/WelcomeScreen';
import { EnvSyncModal } from '../components/EnvSyncModal';
import type {
  CellTab,
  Config,
  AppMenuTopLevel,
  KernelExecutionOrigin,
  LogEntry,
  NoteTab,
  ScriptRunResult,
  TreeChangeInfo,
  TreeNodeData,
  WindowChromeInfo,
} from '../types';
import { resolveShortcuts } from '../shortcuts';
import { newExecutionId, normalizeLoadedCodeCells, normalizeRecentProjects, mergeConfigUpdate } from './app-utils';
import { CELL_UNDO_LIMIT, MAX_LOG_ENTRIES, NAMESPACE_REFRESH_INTERVAL_MS } from './constants';
import { useCodeCellsPersistence } from './useCodeCellsPersistence';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useKernelLifecycle } from './useKernelLifecycle';
import { useLayoutState } from './useLayoutState';
import { useProjectWorkflow } from './useProjectWorkflow';
import { useKernelSubscriptions } from './useKernelSubscriptions';
import { useThemeManager } from './useThemeManager';
import { useTreeAction } from '../hooks/useTreeAction';

type KernelStatus = 'idle' | 'starting' | 'ready' | 'error';
type CodeCellExecutionError = {
  tabId: number;
  message: string;
  location?: { line?: number; column?: number };
};


/** Root PDV application component rendered in the Electron renderer process. */
const App: React.FC = () => {
  const {
    leftSidebarOpen,
    leftPanel,
    editorCollapsed,
    leftWidth,
    editorHeight,
    rightPaneRef,
    startVerticalDrag,
    startHorizontalDrag,
    handleActivityBarClick,
    toggleLeftSidebar,
    toggleEditorCollapsed,
    collapseLeftSidebar,
    expandEditor,
  } = useLayoutState();

  // -- Editor state ----------------------------------------------------------
  const [cellTabs, setCellTabs] = useState<CellTab[]>([{ id: 1, code: '' }]);
  const [activeCellTab, setActiveCellTab] = useState(1);
  const cellTabsRef = useRef(cellTabs);
  cellTabsRef.current = cellTabs;
  const activeCellTabRef = useRef(activeCellTab);
  activeCellTabRef.current = activeCellTab;
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // -- Kernel state ---------------------------------------------------------
  const [activeLanguage, setActiveLanguage] = useState<'python' | 'julia'>('python');
  const [currentKernelId, setCurrentKernelId] = useState<string | null>(null);
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>('idle');
  const [isExecuting, setIsExecuting] = useState(false);
  /** True while a save (auto or explicit) is in flight on the kernel. */
  const [isSaveInFlight, setIsSaveInFlight] = useState(false);
  /** True while a user-submitted run is held in the renderer queue waiting
   * for `isSaveInFlight` to clear. Mutually exclusive with `isExecuting`. */
  const [isQueuedExecution, setIsQueuedExecution] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [codeCellExecutionError, setCodeCellExecutionError] =
    useState<CodeCellExecutionError | undefined>(undefined);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [lastChecksum, setLastChecksum] = useState<string | null>(null);
  const [checksumMismatch, setChecksumMismatch] = useState<boolean>(false);
  const [savedPdvVersion, setSavedPdvVersion] = useState<string | null>(null);
  const [runningPdvVersion, setRunningPdvVersion] = useState<string | null>(null);
  const [interpreterWarning, setInterpreterWarning] = useState<string | null>(null);
  /** Latest RSS in bytes for the active kernel subprocess, or null when unknown. */
  const [kernelMemoryRss, setKernelMemoryRss] = useState<number | null>(null);
  /** Latest auto-update status pushed by the main process. */
  const [updateStatus, setUpdateStatus] = useState<import('../types/pdv').UpdateStatus | null>(null);
  /** True when at least one MCP agent client is currently connected. */
  const [mcpClientAttached, setMcpClientAttached] = useState<boolean>(false);

  // -- App / config state ---------------------------------------------------
  const [config, setConfig] = useState<Config | null>(null);
  const [currentProjectDir, setCurrentProjectDir] = useState<string | null>(null);
  const initRef = useRef(false);
  const loadedProjectTabsRef = useRef<{ tabs: CellTab[]; activeTabId: number } | null>(null);
  /** Deferred project action to execute once the kernel becomes ready. */
  const pendingProjectRef = useRef<
    | { type: 'open'; path?: string; language?: 'python' | 'julia' }
    | { type: 'recover'; orphanDir: string }
    | null
  >(null);

  // Undo stack for cell clear/close. Each entry captures the full tab list and
  // active tab id so a single Cmd+Z restores exactly what was destroyed.
  type CellSnapshot = { tabs: CellTab[]; activeTabId: number };
  const cellUndoStack = useRef<CellSnapshot[]>([]);

  /**
   * Refresh tokens — integer counters bumped to signal child components to re-fetch data.
   * Incrementing a token causes any useEffect that lists it as a dependency to re-run.
   * This is the renderer's lightweight alternative to a pub/sub or state-management library.
   */
  const [autoRefreshNamespace, setAutoRefreshNamespace] = useState(false);
  const [namespaceRefreshToken, setNamespaceRefreshToken] = useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [pendingTreeChanges, setPendingTreeChanges] = useState<TreeChangeInfo[]>([]);
  const [modulesRefreshToken, setModulesRefreshToken] = useState(0);

  const runTreeAction = useTreeAction({ setLastError, setTreeRefreshToken });

  // -- Dialog visibility state ----------------------------------------------

  const [showWelcome, setShowWelcome] = useState(true);
  const [forceWelcome, setForceWelcome] = useState(false);
  const [scriptDialog, setScriptDialog] = useState<TreeNodeData | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ path: string; key: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ path: string; type: string } | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<{ path: string; type: string } | null>(null);
  const [createNodeTarget, setCreateNodeTarget] = useState<string | null>(null);
  const [createScriptTarget, setCreateScriptTarget] = useState<string | null>(null);
  const [createNoteTarget, setCreateNoteTarget] = useState<string | null>(null);
  const [createGuiTarget, setCreateGuiTarget] = useState<string | null>(null);
  const [createLibTarget, setCreateLibTarget] = useState<string | null>(null);
  const [showNewModuleDialog, setShowNewModuleDialog] = useState(false);
  const [moduleMetadataTarget, setModuleMetadataTarget] = useState<
    { alias: string; name: string; version: string; description?: string; language?: 'python' | 'julia' } | null
  >(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showImportModule, setShowImportModule] = useState(false);
  const [showSaveAsDialog, setShowSaveAsDialog] = useState(false);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);
  const [chromeInfo, setChromeInfo] = useState<WindowChromeInfo | null>(null);
  const [menuModel, setMenuModel] = useState<AppMenuTopLevel[]>([]);

  // -- Write tab (markdown notes) state ------------------------------------
  const [activePane, setActivePane] = useState<'code' | 'write'>('code');
  const [noteTabs, setNoteTabs] = useState<NoteTab[]>([]);
  const noteTabsRef = useRef(noteTabs);
  noteTabsRef.current = noteTabs;
  const [activeNoteTabId, setActiveNoteTabId] = useState<string | null>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about'>('general');

  // -- Project reloading state (kernel restart with active project) ----------
  const [projectReloading, setProjectReloading] = useState(false);

  // -- Unsaved-changes guard --------------------------------------------------
  // Conservative first cut: the project is considered dirty as soon as the
  // kernel reaches `ready` and is never cleared (not even by Save). All six
  // destructive actions in issue #156 consult this single boolean through the
  // `guardDirty` helper, so a future PR can refine the heuristic by changing
  // only where/how `setProjectDirty` is called.
  const [projectDirty, setProjectDirty] = useState(false);
  const [pendingDirtyAction, setPendingDirtyAction] = useState<
    { label: string; run: () => void } | null
  >(null);

  // -- Save/load progress state -----------------------------------------------
  const [progress, setProgress] = useState<import('../types/pdv').ProgressPayload | null>(null);

  // -- Imported GUI modules for activity bar ---------------------------------
  const [importedGuiModules, setImportedGuiModules] = useState<{ alias: string; name: string }[]>([]);

  // Fetch GUI modules when kernel or modules refresh token changes
  useEffect(() => {
    if (!currentKernelId || kernelStatus !== 'ready') {
      setImportedGuiModules([]);
      return;
    }
    void (async () => {
      try {
        const imported = await window.pdv.modules.listImported();
        setImportedGuiModules(
          imported.filter((m) => m.hasGui).map((m) => ({ alias: m.alias, name: m.name }))
        );
      } catch {
        setImportedGuiModules([]);
      }
    })();
  }, [currentKernelId, kernelStatus, modulesRefreshToken]);

  // -- Appearance state -----------------------------------------------------
  const monacoTheme = useThemeManager({ config });

  const shortcuts = useMemo(() => resolveShortcuts(config?.settings?.shortcuts), [config]);
  useCodeCellsPersistence({
    cellTabs: cellTabs,
    activeCellTab,
    currentKernelId,
  });

  useEffect(() => {
    // Prevent double initialization in StrictMode
    if (initRef.current) return;
    initRef.current = true;

    const initConfig = async () => {
      try {
        if (!window.pdv?.config) {
          throw new Error('PDV preload API is unavailable. Use the Electron window, not the browser URL.');
        }
        const loaded = await window.pdv.config.get();
        setConfig(loaded);  // theme applied by the reactive effect above
        if (typeof loaded.autoRefreshNamespace === 'boolean') {
          setAutoRefreshNamespace(loaded.autoRefreshNamespace);
        }
        setCurrentProjectDir(null);
        // Kernel is NOT started here — it starts when the user picks a
        // project action from the WelcomeScreen.
      } catch (error) {
        console.error('[App] Failed to load config:', error);
        setLastError(error instanceof Error ? error.message : String(error));
      }
    };

    void initConfig();
    void window.pdv.about.getVersion().then(setRunningPdvVersion).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.pdv.chrome.getInfo().then((info) => {
      if (!cancelled) {
        setChromeInfo(info);
      }
    }).catch(() => {
      if (!cancelled) {
        setChromeInfo(null);
      }
    });
    const unsubscribe = window.pdv.chrome.onStateChanged((info) => {
      setChromeInfo(info);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!chromeInfo?.showMenuBar) {
      setMenuModel([]);
      return;
    }
    let cancelled = false;
    void window.pdv.menu.getModel().then((model) => {
      if (!cancelled) {
        setMenuModel(model);
      }
    }).catch(() => {
      if (!cancelled) {
        setMenuModel([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chromeInfo?.showMenuBar]);

  useEffect(() => {
    const projectName = currentProjectName
      ?? (currentProjectDir
        ? currentProjectDir.split('/').filter(Boolean).pop() ?? 'Unsaved Project'
        : 'Unsaved Project');
    document.title = `PDV: ${projectName}`;
  }, [currentProjectDir, currentProjectName]);

  useEffect(() => {
    if (!window.pdv?.menu) {
      return;
    }
    const recentProjects = normalizeRecentProjects(config?.recentProjects);
    void window.pdv.menu.updateRecentProjects(recentProjects);
  }, [config]);

  // Surface auto-update state in the status bar. Seed from the cached value in
  // case a check completed before the App mounted, then subscribe for live
  // transitions.
  useEffect(() => {
    void window.pdv.updater.getStatus().then((status) => {
      if (status) setUpdateStatus(status);
    });
    return window.pdv.updater.onUpdateStatus(setUpdateStatus);
  }, []);

  // Surface MCP client connection state in the status bar. The MCP server
  // pushes whenever the count of attached client sessions changes; the
  // initial getStatus() call seeds state so a renderer reload while a
  // client is already attached doesn't leave the indicator dark until the
  // next disconnect/reconnect.
  useEffect(() => {
    void window.pdv.mcp.getStatus().then((status) => {
      setMcpClientAttached(status.clientCount > 0);
    });
    return window.pdv.mcp.onClientStatus(({ clientCount }) => {
      setMcpClientAttached(clientCount > 0);
    });
  }, []);

  // Listen for File-menu actions handled at the App level.
  // project:open and project:openRecent are dispatched via refs so this effect
  // doesn't re-subscribe on every kernelStatus change (handlers defined later).
  const handleOpenWithPickerRef = useRef<() => Promise<void>>();
  const handleOpenRecentRef = useRef<(path: string) => Promise<void>>();
  const handleClearRecentsRef = useRef<() => void>();
  useEffect(() => {
    if (!window.pdv?.menu) return;
    const unsub = window.pdv.menu.onAction((payload) => {
      if (payload.action === 'project:open') {
        void handleOpenWithPickerRef.current?.();
      } else if (payload.action === 'project:openRecent') {
        if (payload.path) void handleOpenRecentRef.current?.(payload.path);
      } else if (payload.action === 'modules:import') {
        setShowImportModule(true);
      } else if (payload.action === 'modules:newEmpty') {
        setShowNewModuleDialog(true);
      } else if (payload.action === 'settings:open') {
        setSettingsInitialTab('general');
        setShowSettings(true);
      } else if (payload.action === 'project:new') {
        guardDirtyRef.current('start a new project', () => {
          // Reset renderer-side project state so the workspace behind the
          // splash isn't holding the prior project's tabs/name/checksum.
          // Tree state lives in the kernel and gets cleared on the next
          // language pick (which restarts the kernel via ensureKernel).
          setCurrentProjectName(null);
          setCurrentProjectDir(null);
          setCellTabs([{ id: 1, code: '' }]);
          setActiveCellTab(1);
          setNoteTabs([]);
          setActiveNoteTabId(null);
          setLastChecksum(null);
          setChecksumMismatch(false);
          setSavedPdvVersion(null);
          loadedProjectTabsRef.current = null;
          setProjectDirty(false);
          setForceWelcome(true);
        });
      } else if (payload.action === 'recentProjects:clear') {
        handleClearRecentsRef.current?.();
      }
    });
    return unsub;
  }, []);

  // Sync File-menu enabled state: disable Save/SaveAs/Import when kernel isn't ready.
  const kernelReady = kernelStatus === 'ready';
  useEffect(() => {
    if (!window.pdv?.menu?.updateEnabled) return;
    void window.pdv.menu.updateEnabled({
      'project:save': kernelReady,
      'project:saveAs': kernelReady,
      'modules:import': kernelReady,
      'modules:newEmpty': kernelReady,
    });
  }, [kernelReady]);

  const currentKernelIdRef = useRef(currentKernelId);
  currentKernelIdRef.current = currentKernelId;

  // Guards re-entrant agent-button clicks so a rapid double-click doesn't
  // spawn two terminals. Set true for the duration of the openAgent call.
  const agentLaunchingRef = useRef(false);
  const handleOpenAgent = useCallback(() => {
    if (agentLaunchingRef.current) return;
    agentLaunchingRef.current = true;
    void window.pdv.launchers
      .openAgent()
      .then((result) => {
        if (!result.success) {
          console.error('[pdv] failed to launch agent:', result.error);
          window.alert(result.error ?? 'Failed to launch the AI agent.');
        }
      })
      .finally(() => {
        agentLaunchingRef.current = false;
      });
  }, []);

  const handleOpenWorkingDir = useCallback(() => {
    void window.pdv.launchers.openWorkingDir().then((result) => {
      if (!result.success) {
        console.error('[pdv] failed to open working directory:', result.error);
        window.alert(result.error ?? 'Failed to open the working directory.');
      }
    });
  }, []);

  const handleKernelCrash = useCallback((crashedKernelId: string) => {
    if (crashedKernelId === currentKernelIdRef.current) {
      setKernelStatus('error');
    }
  }, []);

  // Mark the project dirty as soon as the kernel is ready. The flag is never
  // cleared in this conservative first cut — see issue #156.
  useEffect(() => {
    if (kernelStatus === 'ready') {
      setProjectDirty(true);
    }
  }, [kernelStatus]);

  /**
   * Guard a destructive action against unsaved project changes.
   *
   * If the project is not dirty, runs `action` immediately. Otherwise stores
   * it as a pending action and shows the unsaved-changes modal; the modal's
   * Save / Don't Save buttons run the pending action when the user resolves.
   */
  const guardDirty = useCallback((label: string, action: () => void) => {
    if (!projectDirty) {
      action();
      return;
    }
    setPendingDirtyAction({ label, run: action });
  }, [projectDirty]);

  const handleTreeChanged = useCallback((info: TreeChangeInfo) => {
    setPendingTreeChanges((prev) => [...prev, info]);
  }, []);

  const handleTreeChangesConsumed = useCallback((consumed: TreeChangeInfo[]) => {
    setPendingTreeChanges((prev) => {
      // Drop only the consumed snapshot; a push that landed between render
      // and the Tree's consume effect stays queued.
      const consumedSet = new Set(consumed);
      return prev.filter((c) => !consumedSet.has(c));
    });
  }, []);

  useKernelSubscriptions({
    currentKernelId,
    loadedProjectTabsRef,
    setCellTabs,
    setActiveCellTab,
    setLogs,
    setTreeRefreshToken,
    setModulesRefreshToken,
    setProjectReloading,
    setProgress,
    onKernelCrash: handleKernelCrash,
    onTreeChanged: handleTreeChanged,
    setKernelMemoryRss,
  });

  const [environmentMode, setEnvironmentMode] = useState<'uv' | 'shared'>('shared');
  const [uvSync, setUvSync] = useState<{ phase: 'idle' | 'syncing' | 'failed'; output: string; error?: string }>({ phase: 'idle', output: '' });
  const lastUvLaunchRef = useRef<import('../types').KernelUvContext | null>(null);
  const { startKernel, handleEnvSave, handleRestartKernel, lastErrorRef } = useKernelLifecycle({
    config,
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setConfig,
    setLogs,
    setNamespaceRefreshToken,
    setTreeRefreshToken,
    setEnvironmentMode,
  });

  const addCellTab = () => {
    setCellTabs((prev) => {
      const newId = Math.max(0, ...prev.map((t) => t.id)) + 1;
      setActiveCellTab(newId);
      return [...prev, { id: newId, code: '' }];
    });
  };

  const handleTabChange = (id: number) => {
    setActiveCellTab(id);
    setLastError(undefined);
  };

  const handleCodeChange = (id: number, code: string) => {
    setCellTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, code } : tab)));
    if (codeCellExecutionError?.tabId === id) {
      setCodeCellExecutionError(undefined);
    }
  };

  const handleClearConsole = () => {
    setLogs([]);
    setLastDuration(null);
  };

  const handleClearCommand = () => {
    // Snapshot before clearing so Cmd+Z can restore
    cellUndoStack.current = [
      ...cellUndoStack.current,
      { tabs: cellTabs, activeTabId: activeCellTab },
    ].slice(-CELL_UNDO_LIMIT); // keep at most CELL_UNDO_LIMIT levels
    setCellTabs((prev) =>
      prev.map((tab) => (tab.id === activeCellTab ? { ...tab, code: '' } : tab)),
    );
    if (codeCellExecutionError?.tabId === activeCellTab) {
      setCodeCellExecutionError(undefined);
    }
    setLastError(undefined);
  };

  const handleRemoveCellTab = (id: number) => {
    // Snapshot before closing so Cmd+Z can restore
    cellUndoStack.current = [
      ...cellUndoStack.current,
      { tabs: cellTabs, activeTabId: activeCellTab },
    ].slice(-CELL_UNDO_LIMIT);
    setCellTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fallback = { id: 1, code: '' };
        setActiveCellTab(fallback.id);
        return [fallback];
      }
      // If the closed tab was active, move to the tab to its left (or the first tab)
      if (id === activeCellTab) {
        const closedIndex = prev.findIndex((t) => t.id === id);
        const newActive = next[Math.max(0, closedIndex - 1)];
        setActiveCellTab(newActive.id);
      }
      return next;
    });
    if (codeCellExecutionError?.tabId === id) {
      setCodeCellExecutionError(undefined);
    }
    setLastError(undefined);
  };

  const handleRenameCellTab = (id: number, name: string | undefined) => {
    setCellTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, name } : tab)));
  };

  useKeyboardShortcuts({
    shortcuts,
    cellTabs: cellTabs,
    activeCellTab,
    cellUndoStack,
    setCellTabs,
    setActiveCellTab,
    toggleLeftSidebar,
    toggleEditorCollapsed,
    setShowImportModule,
    kernelReady,
    addCellTab,
    removeCellTab: handleRemoveCellTab,
  });

  // Global Escape handler — closes the topmost open dialog/overlay.
  // SettingsDialog handles its own Escape (needs to suppress while recording shortcuts).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Close in priority order (topmost first)
      if (showSaveAsDialog) { setShowSaveAsDialog(false); return; }
      if (showImportModule) { setShowImportModule(false); return; }
      if (scriptDialog) { setScriptDialog(null); return; }
      if (renameTarget) { setRenameTarget(null); return; }
      if (moveTarget) { setMoveTarget(null); return; }
      if (duplicateTarget) { setDuplicateTarget(null); return; }
      if (createNodeTarget) { setCreateNodeTarget(null); return; }
      if (createScriptTarget) { setCreateScriptTarget(null); return; }
      if (createNoteTarget) { setCreateNoteTarget(null); return; }
      if (createGuiTarget) { setCreateGuiTarget(null); return; }
      if (createLibTarget) { setCreateLibTarget(null); return; }
      if (showNewModuleDialog) { setShowNewModuleDialog(false); return; }
      if (moduleMetadataTarget) { setModuleMetadataTarget(null); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSaveAsDialog, showImportModule, scriptDialog, renameTarget, moveTarget, duplicateTarget, createNodeTarget, createScriptTarget, createNoteTarget, createGuiTarget, createLibTarget, showNewModuleDialog, moduleMetadataTarget]);

  const handleSettingsSave = async (updates: Partial<Config>) => {
    await window.pdv.config.set(updates);
    const mergedConfig = config ? mergeConfigUpdate(config, updates) : null;
    setConfig(mergedConfig);  // reactive effect applies theme
    if (
      mergedConfig &&
      ((updates.pythonPath && updates.pythonPath !== config?.pythonPath) ||
        (updates.juliaPath && updates.juliaPath !== config?.juliaPath))
    ) {
      await startKernel(mergedConfig, activeLanguage);
    }
    setShowSettings(false);
  };

  // -- Note (Write tab) helpers --------------------------------------------

  /** Open a markdown node in the Write tab, reading its content from disk. */
  const openNote = async (node: TreeNodeData) => {
    // If already open, just switch to it
    const existing = noteTabs.find((t) => t.id === node.path);
    if (existing) {
      setActiveNoteTabId(node.path);
      setActivePane('write');
      return;
    }

    if (!currentKernelId) return;

    try {
      const result = await window.pdv.note.read(currentKernelId, node.path);
      const content = result.success && result.content ? result.content : '';
      const newTab: NoteTab = {
        id: node.path,
        content,
        savedContent: content,
        name: node.key,
      };
      setNoteTabs((prev) => [...prev, newTab]);
      setActiveNoteTabId(node.path);
      setActivePane('write');
    } catch (error) {
      console.error('[App] Failed to read note:', error);
      setLastError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleNoteContentChange = (id: string, content: string) => {
    setNoteTabs((prev) =>
      prev.map((tab) => (tab.id === id ? { ...tab, content } : tab)),
    );
  };

  const handleNoteSave = async (id: string) => {
    const tab = noteTabs.find((t) => t.id === id);
    if (!tab || tab.content === tab.savedContent || !currentKernelId) return;
    try {
      await window.pdv.note.save(currentKernelId, tab.id, tab.content);
      setNoteTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, savedContent: t.content } : t)),
      );
    } catch (error) {
      // Surface the failure in the console — the tab stays dirty, so the
      // edits are not lost and the dirty dot keeps showing.
      const message = error instanceof Error ? error.message : String(error);
      setLogs((prev) => [...prev, {
        id: `note-save-error-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        error: `Failed to save note "${tab.name}": ${message}`,
      }]);
    }
  };

  const flushDirtyNotes = useCallback(async () => {
    if (!currentKernelId) return;
    const dirty = noteTabsRef.current.filter((t) => t.content !== t.savedContent);
    await Promise.all(
      dirty.map(async (tab) => {
        try {
          await window.pdv.note.save(currentKernelId, tab.id, tab.content);
          setNoteTabs((prev) =>
            prev.map((t) => (t.id === tab.id ? { ...t, savedContent: t.content } : t)),
          );
        } catch (error) {
          console.error('[App] Failed to flush note:', error);
        }
      }),
    );
  }, [currentKernelId]);

  const handleNoteCloseTab = async (id: string) => {
    // Closing a dirty note flushes it first — the note lives in the tree,
    // so a silent discard would lose real edits. Only ask the user when
    // the flush can't happen (no kernel) or fails.
    const tab = noteTabsRef.current.find((t) => t.id === id);
    if (tab && tab.content !== tab.savedContent) {
      let flushed = false;
      if (currentKernelId) {
        try {
          await window.pdv.note.save(currentKernelId, tab.id, tab.content);
          flushed = true;
        } catch (error) {
          console.error('[App] Failed to save note before closing:', error);
        }
      }
      if (!flushed) {
        const discard = window.confirm(
          `"${tab.name}" has unsaved changes that could not be saved. Close it anyway and discard them?`,
        );
        if (!discard) return;
      }
    }
    setNoteTabs((prev) => {
      const updated = prev.filter((t) => t.id !== id);
      if (activeNoteTabId === id) {
        setActiveNoteTabId(updated.length > 0 ? updated[updated.length - 1].id : null);
      }
      if (updated.length === 0) {
        setActivePane('code');
      }
      return updated;
    });
  };

  const handleTreeAction = async (action: string, node: TreeNodeData) => {
    if (action === 'open_gui') {
      if (!currentKernelId) return;
      // Module-owned GUIs use the module window system; standalone GUIs use the viewer
      if (node.moduleId) {
        const alias = node.type === 'gui' && node.parentPath ? node.parentPath : node.key;
        void window.pdv.moduleWindows.open({ alias, kernelId: currentKernelId });
      } else {
        void window.pdv.guiEditor.openViewer({ treePath: node.path, kernelId: currentKernelId });
      }
      return;
    }
    if (action === 'edit_gui') {
      if (!currentKernelId) return;
      void window.pdv.guiEditor.open({ treePath: node.path, kernelId: currentKernelId });
      return;
    }
    if (action === 'new_gui') {
      setCreateGuiTarget(node.path);
      return;
    }
    if (action === 'create_node') {
      setCreateNodeTarget(node.path);
    } else if (action === 'create_script') {
      setCreateScriptTarget(node.path);
    } else if (action === 'create_lib') {
      setCreateLibTarget(node.path);
    } else if (action === 'edit_module_metadata' && node.type === 'module') {
      setModuleMetadataTarget({
        alias: node.path || node.key,
        name: node.moduleName ?? node.key,
        version: node.moduleVersion ?? '0.1.0',
        description: node.moduleDescription,
        language: node.moduleLanguage,
      });
    } else if (action === 'export_module' && node.type === 'module') {
      try {
        const result = await window.pdv.modules.exportFromProject({
          alias: node.path || node.key,
        });
        if (!result.success) {
          if (result.status !== 'cancelled') {
            setLastError(result.error ?? 'Failed to export module');
          }
        } else {
          // Trigger an installed-modules refresh so the Import dialog
          // picks up the newly-published module for future imports.
          setModulesRefreshToken((t) => t + 1);
        }
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error));
      }
    } else if (action === 'create_note') {
      setCreateNoteTarget(node.path);
    } else if (action === 'open_note' && node.type === 'markdown') {
      await openNote(node);
    } else if (action === 'run' && node.type === 'script') {
      setScriptDialog(node);
    } else if (action === 'run_defaults' && node.type === 'script') {
      if (!currentKernelId) return;
      const executionId = newExecutionId();
      const origin: KernelExecutionOrigin = {
        kind: 'tree-script',
        label: node.path,
        scriptPath: node.path,
      };
      const runResult = await window.pdv.script.run(currentKernelId, {
        treePath: node.path,
        params: {},
        executionId,
        origin,
      });
      handleScriptRun(runResult);
    } else if (action === 'edit' && (node.type === 'script' || node.type === 'namelist' || node.type === 'lib' || node.type === 'markdown')) {
      try {
        if (!currentKernelId) return;
        await window.pdv.script.edit(currentKernelId, node.path);
      } catch (error) {
        console.error('[App] Failed to open editor:', error);
      }
    } else if (action === 'copy_path') {
      // Clipboard snippet (valid in both Python and Julia sessions —
      // PDVTree indexes the same way in each). JSON.stringify escapes
      // quotes/backslashes in keys so the pasted expression stays valid.
      const indexExpr = node.path
        ? node.path.split('.').reduce((acc, part) => `${acc}[${JSON.stringify(part)}]`, 'pdv_tree')
        : 'pdv_tree';
      await navigator.clipboard.writeText(indexExpr);
    } else if (action === 'handle') {
      if (!currentKernelId) return;
      const result = await window.pdv.tree.invokeHandler(currentKernelId, node.path);
      if (!result.success && result.error) {
        console.error('[App] Handler failed:', result.error);
      }
    } else if (action === 'rename') {
      if (node.path) {
        setRenameTarget({ path: node.path, key: node.key });
      }
    } else if (action === 'move') {
      if (node.path) {
        setMoveTarget({ path: node.path, type: node.type });
      }
    } else if (action === 'duplicate') {
      if (node.path) {
        setDuplicateTarget({ path: node.path, type: node.type });
      }
    } else if (action === 'delete') {
      if (!currentKernelId || !node.path) return;
      const confirmed = window.confirm(
        `Delete "${node.path}" from the tree?\n\nThis cannot be undone.`
      );
      if (!confirmed) return;
      const result = await window.pdv.tree.delete(currentKernelId, node.path);
      if (!result.success) {
        console.error('[App] Delete failed:', result.error);
      }
    } else if (action === 'print') {
      if (!currentKernelId) return;
      // The main process builds the language-appropriate print invocation —
      // no Python or Julia code strings belong in the renderer.
      const printResult = await window.pdv.tree.print(currentKernelId, {
        path: node.path,
        executionId: newExecutionId(),
        origin: {
          kind: 'unknown',
          label: `Tree print ${node.path || 'pdv_tree'}`,
        },
      });
      handleScriptRun(printResult);
    }
  };

  const handleScriptRun = ({
    code,
    executionId,
    origin,
    result,
  }: ScriptRunResult) => {
    const resolvedOrigin = result.errorDetails?.source ?? origin;
    const logEntry: LogEntry = {
      id: executionId,
      timestamp: Date.now(),
      code,
      stdout: result.stdout,
      stderr: result.stderr,
      result: result.result,
      error: result.error,
      errorDetails: result.errorDetails,
      origin: resolvedOrigin,
      duration: result.duration,
      images: result.images,
    };
    setLogs((prev) => {
      const next = [...prev, logEntry];
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
    });
    if (result.error) {
      setLastError(result.error);
    }
    if (typeof result.duration === 'number') {
      setLastDuration(result.duration);
    }
    setNamespaceRefreshToken((prev) => prev + 1);
    setScriptDialog(null);
  };

  // Single-slot queue for a run held while a save is in flight. Stored in a
  // ref because the *contents* don't drive UI updates (the boolean flag does)
  // and so the drain effect below can read the latest payload without being
  // re-created when it changes.
  const queuedExecutionRef = useRef<{ code: string; originOverride?: KernelExecutionOrigin } | null>(null);
  const isSaveInFlightRef = useRef(false);
  useEffect(() => { isSaveInFlightRef.current = isSaveInFlight; }, [isSaveInFlight]);

  const executeImmediate = useCallback(async (code: string, originOverride?: KernelExecutionOrigin) => {
    if (!currentKernelId || kernelStatus !== 'ready' || !code.trim()) return;

    setIsExecuting(true);
    setLastError(undefined);
    setCodeCellExecutionError(undefined);

    const executionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const currentCellTabs = cellTabsRef.current;
    const currentActiveCellTab = activeCellTabRef.current;
    const activeTab = currentCellTabs.find((tab) => tab.id === currentActiveCellTab);
    const origin: KernelExecutionOrigin = originOverride ?? {
      kind: 'code-cell',
      label: activeTab?.name?.trim() ? activeTab.name : `Tab ${currentActiveCellTab}`,
      tabId: currentActiveCellTab,
    };

    // Create the log entry immediately so output appears as it streams in.
    setLogs((prev) => {
      const next = [
        ...prev,
        { id: executionId, timestamp: Date.now(), code, origin },
      ];
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
    });

    try {
      const result = await window.pdv.kernels.execute(currentKernelId, {
        code,
        executionId,
        origin,
      });

      // Finalize the entry with duration and any error (stdout/stderr already streamed).
      setLogs((prev) =>
        prev.map((l) =>
          l.id === executionId
            ? {
                ...l,
                stdout: l.stdout ?? result.stdout,
                stderr: l.stderr ?? result.stderr,
                result: l.result ?? result.result,
                images: l.images ?? result.images,
                error: result.error,
                errorDetails: result.errorDetails,
                origin: l.origin ?? origin,
                duration: result.duration,
              }
            : l
        )
      );

      if (result.error) {
        setLastError(result.error);
        if (origin.kind === 'code-cell' && typeof origin.tabId === 'number') {
          setCodeCellExecutionError({
            tabId: origin.tabId,
            message: result.errorDetails?.message || result.error,
            location: result.errorDetails?.location,
          });
        }
      }
      if (typeof result.duration === 'number') {
        setLastDuration(result.duration);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLogs((prev) =>
        prev.map((l) => (l.id === executionId ? { ...l, error: msg, origin } : l))
      );
      setLastError(msg);
      setCodeCellExecutionError(undefined);
    } finally {
      setIsExecuting(false);
      setNamespaceRefreshToken((prev) => prev + 1);
      // Defense in depth: a script that mutates a sub-PDVTree directly
      // (e.g. `pdv_tree['big']['x'] = ...`) doesn't fire `pdv.tree.changed`
      // because sub-trees don't carry _send_fn. Refetching the tree after
      // execution catches those silent mutations even before that's fixed
      // properly upstream, and is cheap (a single tree.list query).
      setTreeRefreshToken((prev) => prev + 1);
    }
  }, [currentKernelId, kernelStatus]);

  /**
   * Public execute entry point. Routes to {@link executeImmediate} unless a
   * save is in flight, in which case the run is held in
   * {@link queuedExecutionRef} until the autosave-ended push fires.
   *
   * Reads `isSaveInFlight` from a ref so the callback identity stays stable
   * across save transitions (otherwise `useEffect`s that depend on it would
   * tear down their listeners every time a save started or ended).
   */
  const handleExecute = useCallback(async (code: string, originOverride?: KernelExecutionOrigin) => {
    if (!currentKernelId || kernelStatus !== 'ready' || !code.trim()) return;
    if (isSaveInFlightRef.current) {
      queuedExecutionRef.current = { code, originOverride };
      setIsQueuedExecution(true);
      return;
    }
    await executeImmediate(code, originOverride);
  }, [currentKernelId, kernelStatus, executeImmediate]);

  const handleCancelQueued = useCallback(() => {
    queuedExecutionRef.current = null;
    setIsQueuedExecution(false);
  }, []);

  // Drain the queued run when a save finishes.
  useEffect(() => {
    if (!isSaveInFlight && isQueuedExecution) {
      const queued = queuedExecutionRef.current;
      queuedExecutionRef.current = null;
      setIsQueuedExecution(false);
      if (queued) {
        void executeImmediate(queued.code, queued.originOverride);
      }
    }
  }, [isSaveInFlight, isQueuedExecution, executeImmediate]);

  /**
   * Run pdv.install("<name>") for a missing module (reactive affordance,
   * §10.5.12). The main process builds the code string and streams the run
   * to the console via executeBegin/executeOutput/executeFinish pushes.
   */
  const handleInstallMissingModule = useCallback((moduleName: string) => {
    if (!currentKernelId) return;
    void window.pdv.environment.installModule(currentKernelId, moduleName).catch((error) => {
      // The failure itself is already logged in the console via the
      // executeFinish push; this guards against IPC-level rejections.
      console.error('[App] pdv.install dispatch failed:', error);
    });
  }, [currentKernelId]);

  // Subscribe to autosave-in-flight pushes from main.
  useEffect(() => {
    if (!window.pdv?.autosave?.onInFlightChange) return;
    return window.pdv.autosave.onInFlightChange(setIsSaveInFlight);
  }, []);

  // Listen for execution requests from module popup windows
  useEffect(() => {
    if (!window.pdv?.moduleWindows) return;
    const unsub = window.pdv.moduleWindows.onExecuteRequest((code: string) => {
      if (!currentKernelId) return;
      void handleExecute(code);
    });
    return unsub;
  }, [currentKernelId, handleExecute]);

  // Most-recent successful autosave timestamp (ms since epoch). Cleared on
  // project change so the status bar reflects the active session, not stale data.
  const [lastAutosaveAt, setLastAutosaveAt] = useState<number | null>(null);
  useEffect(() => {
    setLastAutosaveAt(null);
  }, [currentProjectDir]);

  // Autosave: respond to main process trigger by sending current code cells
  useEffect(() => {
    if (!window.pdv?.autosave) return;
    const unsub = window.pdv.autosave.onTrigger(() => {
      const codeCells = { tabs: cellTabsRef.current, activeTabId: activeCellTab };
      void window.pdv.autosave.run(codeCells).then(
        (result) => {
          if (result?.saved) setLastAutosaveAt(Date.now());
        },
        (err) => { console.warn('[autosave] run failed', err); },
      );
    });
    return unsub;
  }, [activeCellTab]);

  // MCP cell tools (ARCHITECTURE.md §15.8): the main process pushes cell
  // read requests for `cell_list`/`cell_read` and one-way `cell_write`
  // pushes. Mirrors the autosave round-trip pattern above.
  useEffect(() => {
    if (!window.pdv?.cells) return;
    const offRequest = window.pdv.cells.onRequest((req) => {
      const tabs = cellTabsRef.current;
      const respond = window.pdv.cells.respond;
      if (req.op === 'list') {
        void respond({
          requestId: req.requestId,
          ok: true,
          result: {
            tabs: tabs.map((t) => ({
              id: t.id,
              name: t.name,
              length: t.code.length,
            })),
            activeTabId: activeCellTab ?? null,
          },
        });
        return;
      }
      if (req.op === 'read') {
        const tab = tabs.find((t) => t.id === req.tabId);
        if (!tab) {
          void respond({
            requestId: req.requestId,
            ok: false,
            error: `No cell tab with id ${req.tabId}`,
          });
          return;
        }
        void respond({
          requestId: req.requestId,
          ok: true,
          result: { id: tab.id, name: tab.name, code: tab.code },
        });
      }
    });
    const offWrite = window.pdv.cells.onWrite((write) => {
      let activatedId: number | null = null;
      setCellTabs((prev) => {
        if (
          typeof write.tabId === 'number' &&
          prev.some((t) => t.id === write.tabId)
        ) {
          activatedId = write.tabId;
          return prev.map((t) =>
            t.id === write.tabId
              ? { ...t, code: write.code, name: write.name ?? t.name }
              : t,
          );
        }
        const nextId =
          prev.length === 0 ? 1 : Math.max(...prev.map((t) => t.id)) + 1;
        activatedId = nextId;
        return [
          ...prev,
          { id: nextId, code: write.code, name: write.name },
        ];
      });
      // Bring focus to whichever tab the agent just wrote — both append and
      // overwrite. Without this on overwrite, an agent edit to a non-active
      // tab is silent ("agent rewrote cell 3, user was on cell 5"), which is
      // the same surprise the append case would have without activation.
      if (activatedId !== null) {
        setActiveCellTab(activatedId);
      }
    });
    return () => {
      offRequest();
      offWrite();
    };
  }, [activeCellTab]);

  // Whether the session has no user work (no project, no code, no logs, no notes).
  const isPristine = currentProjectDir === null
    && cellTabs.every((t) => !t.code.trim())
    && logs.length === 0
    && noteTabs.length === 0;

  const {
    handleSaveProject,
    executeOpenProject,
  } = useProjectWorkflow({
    kernelStatus,
    currentProjectDir,
    cellTabs: cellTabs,
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
  });

  // Subscribe to main-process close requests (title-bar X, OS close, Cmd+Q)
  // and route them through the same dirty-action guard. The latest
  // `handleSaveProject` is captured via a ref so the listener doesn't need to
  // re-subscribe on every render.
  const handleSaveProjectRef = useRef(handleSaveProject);
  handleSaveProjectRef.current = handleSaveProject;
  const guardDirtyRef = useRef(guardDirty);
  guardDirtyRef.current = guardDirty;
  useEffect(() => {
    if (!window.pdv?.app) return;
    return window.pdv.app.onRequestClose(() => {
      guardDirtyRef.current('exit PDV', () => {
        void window.pdv.app.confirmClose();
      });
    });
  }, []);

  useEffect(() => {
    void window.pdv?.app?.setDocumentEdited(projectDirty);
  }, [projectDirty]);

  // -- Welcome screen (pristine session) ------------------------------------

  const recentProjectPaths = useMemo(
    () => normalizeRecentProjects(config?.recentProjects),
    [config?.recentProjects],
  );

  /** Build RecentProject[] with language and name metadata from project.json files. */
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  useEffect(() => {
    if (recentProjectPaths.length === 0) {
      setRecentProjects([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      recentProjectPaths.map(async (p) => {
        try {
          const peek = await window.pdv.project.peekManifest(p);
          return { path: p, language: peek.language, name: peek.projectName } as RecentProject;
        } catch {
          return { path: p } as RecentProject;
        }
      })
    ).then((results) => {
      if (!cancelled) setRecentProjects(results);
    });
    return () => { cancelled = true; };
  }, [recentProjectPaths]);

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

  /**
   * Starts the kernel for the current config, or shows the environment
   * selector if no interpreter path is configured for the given language.
   */
  const openEnvSettings = useCallback((warning?: string) => {
    if (warning) setInterpreterWarning(warning);
    setSettingsInitialTab('runtime');
    setShowSettings(true);
  }, []);

  // --- uv environment setup modal ----------------------------------------
  // Stream uv output into the EnvSyncModal while a uv-project launch runs.
  useEffect(() => {
    const unsub = window.pdv.environment.onEnvActivity((chunk) => {
      setUvSync((s) => (s.phase === 'idle' ? s : { ...s, output: s.output + chunk.data }));
    });
    return unsub;
  }, []);

  /**
   * Launch (or relaunch) a uv-project kernel behind the blocking EnvSyncModal.
   * Resolves true on success; on failure the modal stays up with Retry/Cancel.
   */
  const launchUvKernel = useCallback(async (uvContext: import('../types').KernelUvContext): Promise<boolean> => {
    lastUvLaunchRef.current = uvContext;
    setActiveLanguage('python');
    setUvSync({ phase: 'syncing', output: '' });
    const ok = await startKernel(config ?? {} as Config, 'python', uvContext);
    if (ok) {
      setUvSync({ phase: 'idle', output: '' });
    } else {
      setUvSync((s) => ({ phase: 'failed', output: s.output, error: lastErrorRef.current }));
    }
    return ok;
  }, [config, startKernel, lastErrorRef]);

  /** Retry a failed uv environment setup (replays the last launch). */
  const handleUvSyncRetry = useCallback(() => {
    const ctx = lastUvLaunchRef.current;
    if (ctx) void launchUvKernel(ctx);
  }, [launchUvKernel]);

  /** Abandon a failed uv environment setup and return to the welcome screen. */
  const handleUvSyncCancel = useCallback(() => {
    setUvSync({ phase: 'idle', output: '' });
    setForceWelcome(true);
  }, []);

  const ensureKernel = useCallback(async (language: 'python' | 'julia' = 'python') => {
    setActiveLanguage(language);
    if (language === 'julia') {
      const ok = await startKernel(config ?? {} as Config, 'julia');
      if (!ok) openEnvSettings(lastErrorRef.current ?? 'Kernel failed to start.');
    } else {
      if (!config?.pythonPath) {
        openEnvSettings();
        return;
      }
      // Pre-flight: check that the configured interpreter has a compatible pdv-python.
      try {
        const envInfo = await window.pdv.environment.check(config.pythonPath);
        if (envInfo && (!envInfo.pdvInstalled || !envInfo.pdvCompatible)) {
          const msg = envInfo.pdvInstalled
            ? `pdv-python ${envInfo.pdvVersion} is installed but ${runningPdvVersion ? `v${runningPdvVersion}` : 'a compatible version'} is required. Please update.`
            : 'pdv-python is not installed in the configured environment.';
          openEnvSettings(msg);
          return;
        }
      } catch {
        // Probe failed — try starting anyway
      }
      const ok = await startKernel(config, 'python');
      if (!ok) openEnvSettings(lastErrorRef.current ?? 'Kernel failed to start.');
    }
  }, [config, runningPdvVersion, startKernel, openEnvSettings, lastErrorRef]);

  const handleWelcomeNewProject = useCallback(async (language: 'python' | 'julia') => {
    if (language === 'python') {
      // New Python projects open the setup dialog first (§10.5.8); the
      // welcome screen stays mounted underneath until Create/Cancel.
      setShowNewProjectDialog(true);
      return;
    }
    dismissWelcome();
    await ensureKernel(language);
  }, [dismissWelcome, ensureKernel]);

  /** Create a uv-managed project with the dialog's version/package choices. */
  const handleNewProjectCreateUv = useCallback(async (opts: { pythonVersion: string; packages: string[] }) => {
    setShowNewProjectDialog(false);
    dismissWelcome();
    // The EnvSyncModal covers the venv build (including a first-time
    // interpreter download); ensureKernel's shared-env pre-flight does not apply.
    await launchUvKernel({
      newProject: true,
      pythonVersion: opts.pythonVersion,
      packages: opts.packages,
    });
  }, [dismissWelcome, launchUvKernel]);

  /**
   * Create a project on an existing (conda/system) interpreter chosen in the
   * dialog's advanced expander. Session-scoped override — the global config
   * is not touched; the choice reaches the manifest on first save (§10.5).
   */
  const handleNewProjectCreateShared = useCallback(async (pythonPath: string) => {
    setShowNewProjectDialog(false);
    dismissWelcome();
    setActiveLanguage('python');
    const overrideConfig: Config = { ...(config ?? {} as Config), pythonPath };
    const ok = await startKernel(overrideConfig, 'python');
    if (!ok) openEnvSettings(lastErrorRef.current ?? 'Kernel failed to start with the selected environment.');
  }, [config, dismissWelcome, startKernel, openEnvSettings, lastErrorRef]);

  /**
   * Open a project from the welcome screen. Peeks at the manifest to detect
   * language and saved interpreter path, then starts the kernel with the
   * saved interpreter if available, or opens the env selector if not.
   */
  const openProjectFromWelcome = useCallback(async (dir: string) => {
    const peek = await window.pdv.project.peekManifest(dir);
    const language = peek.language ?? 'python';
    dismissWelcome();
    setInterpreterWarning(null);
    pendingProjectRef.current = { type: 'open', path: dir, language };

    // uv-mode projects own their environment: the EnvSyncModal covers venv
    // materialization, so shared-interpreter detection is skipped (§10.5.9).
    if (peek.environment?.mode === 'uv' && language === 'python') {
      await launchUvKernel({ saveDir: dir });
      return;
    }

    // If the project saved an interpreter path, try to use it.
    // TODO: Add Julia interpreter validation once Julia supports saved interpreter paths.
    if (peek.interpreterPath && language === 'python') {
      try {
        const envInfo = await window.pdv.environment.check(peek.interpreterPath);
        if (envInfo && envInfo.pdvInstalled && envInfo.pdvCompatible) {
          // Use the project's saved interpreter
          setActiveLanguage(language);
          const overrideConfig: Config = {
            ...config ?? {} as Config,
            pythonPath: peek.interpreterPath,
          };
          await startKernel(overrideConfig, language);
          return;
        }
      } catch {
        // Probe failed — fall through to env selector
      }
      // Saved interpreter unavailable — warn and open settings
      setActiveLanguage(language);
      openEnvSettings(`The interpreter saved with this project (${peek.interpreterPath}) is no longer available.`);
      return;
    }

    await ensureKernel(language);
  }, [config, dismissWelcome, ensureKernel, openEnvSettings, startKernel, launchUvKernel]);

  /**
   * Open a project via the file picker, with smart-open resolution.
   * Works both from the welcome screen (kernel not ready) and after kernel start.
   */
  const handleOpenWithPicker = useCallback(async () => {
    const defaultPath = currentProjectDir
      ? currentProjectDir.replace(/\/[^/]+\/?$/, '')
      : undefined;
    const dir = await window.pdv.files.pickDirectory(defaultPath);
    if (!dir) return;
    if (kernelStatus === 'ready') {
      guardDirty('open another project', () => {
        dismissWelcome();
        void executeOpenProject(dir);
      });
    } else {
      await openProjectFromWelcome(dir);
    }
  }, [currentProjectDir, kernelStatus, executeOpenProject, openProjectFromWelcome, guardDirty, dismissWelcome]);

  const handleOpenRecent = useCallback(async (path: string) => {
    if (kernelStatus === 'ready') {
      guardDirty('open another project', () => {
        dismissWelcome();
        void executeOpenProject(path);
      });
    } else {
      await openProjectFromWelcome(path);
    }
  }, [kernelStatus, executeOpenProject, openProjectFromWelcome, guardDirty, dismissWelcome]);

  /**
   * Recover an orphaned autosave into the active kernel session. The recovered
   * tree + code-cells land in an unsaved-project state — the user must Save As
   * to persist them.
   */
  const executeRecoverUnsaved = useCallback(async (orphanDir: string) => {
    if (kernelStatus !== 'ready') return;
    try {
      const result = await window.pdv.autosave.recoverUnsaved(orphanDir);
      const normalized = normalizeLoadedCodeCells(result.codeCells);
      loadedProjectTabsRef.current = normalized;
      setCellTabs(normalized.tabs);
      setActiveCellTab(normalized.activeTabId);
      setCurrentProjectDir(null);
      setCurrentProjectName(null);
      setModulesRefreshToken((prev) => prev + 1);
      setNamespaceRefreshToken((prev) => prev + 1);

      const missingWarn = result.missingFiles?.length
        ? `\nWarning: ${result.missingFiles.length} file(s) could not be copied:\n  ${result.missingFiles.join('\n  ')}`
        : '';
      setLogs((prev) => [...prev, {
        id: `recover-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: `Recovered unsaved session — use File → Save to keep it.${missingWarn}`,
      }]);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      void refreshRecoverableSessions();
    }
  }, [
    kernelStatus,
    setCellTabs,
    setActiveCellTab,
    setCurrentProjectDir,
    setCurrentProjectName,
    setModulesRefreshToken,
    setNamespaceRefreshToken,
    setLogs,
    setLastError,
    refreshRecoverableSessions,
  ]);

  const handleRecoverSession = useCallback((orphanDir: string) => {
    if (kernelStatus === 'ready') {
      guardDirty('recover an unsaved session', () => { void executeRecoverUnsaved(orphanDir); });
      return;
    }
    dismissWelcome();
    setInterpreterWarning(null);
    pendingProjectRef.current = { type: 'recover', orphanDir };
    void ensureKernel('python');
  }, [kernelStatus, guardDirty, executeRecoverUnsaved, dismissWelcome, ensureKernel]);

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
  // File → Clear Menu action (see the menuAction useEffect below).
  const handleClearRecents = useCallback(() => {
    void window.pdv.config.set({ recentProjects: [] }).then((updated) => {
      if (updated) setConfig((prev) => (prev ? { ...prev, recentProjects: [] } : prev));
    });
    void window.pdv.menu.updateRecentProjects([]);
  }, []);

  // Keep refs in sync so the menu-action effect (subscribed once) calls the latest handlers.
  handleOpenWithPickerRef.current = handleOpenWithPicker;
  handleOpenRecentRef.current = handleOpenRecent;
  handleClearRecentsRef.current = handleClearRecents;

  // Execute deferred project action once the kernel becomes ready.
  useEffect(() => {
    if (kernelStatus !== 'ready' || !pendingProjectRef.current) return;
    const pending = pendingProjectRef.current;
    pendingProjectRef.current = null;
    if (pending.type === 'recover') {
      void executeRecoverUnsaved(pending.orphanDir);
    } else {
      void executeOpenProject(pending.path);
    }
  }, [kernelStatus, executeOpenProject, executeRecoverUnsaved]);

  const projectTitle = currentProjectName
    ?? (currentProjectDir
      ? currentProjectDir.split('/').filter(Boolean).pop() ?? 'Unsaved Project'
      : 'Unsaved Project');

  return (
    <div className="app">
      {chromeInfo?.showCustomTitleBar && (
        <TitleBar
          chromeInfo={chromeInfo}
          menuModel={menuModel}
          title={projectTitle}
        />
      )}

      {/* uv environment setup — blocking modal during a uv-project launch */}
      {uvSync.phase !== 'idle' && (
        <EnvSyncModal
          phase={uvSync.phase}
          output={uvSync.output}
          errorMessage={uvSync.error}
          onRetry={handleUvSyncRetry}
          onCancel={handleUvSyncCancel}
        />
      )}

      {/* Main content */}
      <main className="app-main">

        {/* Project reloading overlay — shown during kernel restart with active project */}
        {projectReloading && (
          <div className="project-reloading-overlay">
            <div className="project-reloading-message">Reloading project...</div>
          </div>
        )}

        {/* Activity bar — always visible */}
        <ActivityBar
          leftSidebarOpen={leftSidebarOpen}
          leftPanel={leftPanel}
          onActivityBarClick={handleActivityBarClick}
          onSettingsClick={() => { setSettingsInitialTab('general'); setShowSettings(true); }}
          onAgentClick={handleOpenAgent}
          onOpenWorkingDir={handleOpenWorkingDir}
          guiModules={importedGuiModules}
          kernelId={currentKernelId}
        />

        {/* Left sidebar — collapsible */}
        {leftSidebarOpen && (
          <>
            <aside className="left-sidebar" style={{ width: `${leftWidth}px` }}>
              <div className="sidebar-header">
                <span className="sidebar-title">{leftPanel === 'tree' ? 'Tree' : 'Namespace'}</span>
                <button
                  className="sidebar-collapse-btn"
                  onClick={collapseLeftSidebar}
                  title="Collapse sidebar"
                >
                  ‹
                </button>
              </div>
              <div className="sidebar-content">
                {leftPanel === 'tree' && (
                  <Tree
                    kernelId={currentKernelId}
                    disabled={kernelStatus !== 'ready'}
                    refreshToken={treeRefreshToken}
                    pendingChanges={pendingTreeChanges}
                    onChangesConsumed={handleTreeChangesConsumed}
                    onAction={handleTreeAction}
                    shortcuts={shortcuts}
                    projectKey={currentProjectDir}

                  />
                )}
                {leftPanel === 'namespace' && (
                  <NamespaceView
                    kernelId={currentKernelId}
                    disabled={kernelStatus !== 'ready'}
                    autoRefresh={autoRefreshNamespace}
                    refreshToken={namespaceRefreshToken}
                    refreshInterval={NAMESPACE_REFRESH_INTERVAL_MS}
                    onToggleAutoRefresh={(next) => {
                      setAutoRefreshNamespace(next);
                      void window.pdv.config.set({ autoRefreshNamespace: next }).then((updated) => {
                        if (updated) setConfig((prev) => (prev ? { ...prev, autoRefreshNamespace: next } : prev));
                      });
                    }}
                  />
                )}
              </div>
            </aside>
            <div className="vertical-resizer" onMouseDown={startVerticalDrag} />
          </>
        )}

        {/* Center column: pane switcher at top, then Code (console + editor) or Write */}
        <div className="center-column" ref={rightPaneRef}>
          <div className="pane-switcher">
            <div className="pane-switcher-track">
              <button
                className={`pane-switcher-btn ${activePane === 'code' ? 'active' : ''}`}
                onClick={() => setActivePane('code')}
              >
                Code
              </button>
              <button
                className={`pane-switcher-btn ${activePane === 'write' ? 'active' : ''}`}
                onClick={() => setActivePane('write')}
              >
                Write
                {noteTabs.some((t) => t.content !== t.savedContent) && (
                  <span className="pane-switcher-indicator">●</span>
                )}
              </button>
            </div>
          </div>

          {activePane === 'code' ? (
            <>
              <div className="console-wrapper">
                <Console
                  logs={logs}
                  onClear={handleClearConsole}
                  onInstallPackage={environmentMode === 'uv' ? handleInstallMissingModule : undefined}
                />
              </div>
              {editorCollapsed ? (
                <div
                  className="editor-collapsed-bar"
                  onClick={expandEditor}
                >
                  ▲ Editor
                </div>
              ) : (
                <>
                  <div className="horizontal-resizer" onMouseDown={startHorizontalDrag} />
                  <div className="editor-wrapper" style={{ height: `${editorHeight}px` }}>
                    <CodeCell
                      tabs={cellTabs.map((tab) => ({
                        ...tab,
                        onChange: (code: string) => handleCodeChange(tab.id, code),
                      }))}
                      activeTabId={activeCellTab}
                      kernelId={currentKernelId}
                      disabled={kernelStatus !== 'ready'}
                      onTabChange={handleTabChange}
                      onAddTab={addCellTab}
                      onRemoveTab={handleRemoveCellTab}
                      onRenameTab={handleRenameCellTab}
                      onExecute={handleExecute}
                      onInterrupt={currentKernelId ? () => { void window.pdv.kernels.interrupt(currentKernelId); } : undefined}
                      onCancelQueued={handleCancelQueued}
                      onClear={handleClearCommand}
                      isExecuting={isExecuting}
                      isQueued={isQueuedExecution}
                      lastError={lastError}
                      executionError={codeCellExecutionError}
                      shortcuts={shortcuts}
                      monacoTheme={monacoTheme}
                      editorFontFamily={config?.settings?.fonts?.codeFont}
                      editorFontSize={config?.settings?.editor?.fontSize}
                      editorTabSize={config?.settings?.editor?.tabSize}
                      editorWordWrap={config?.settings?.editor?.wordWrap}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="write-tab-fill">
              <WriteTab
                tabs={noteTabs}
                activeTabId={activeNoteTabId}
                disabled={kernelStatus !== 'ready'}
                onTabChange={setActiveNoteTabId}
                onCloseTab={handleNoteCloseTab}
                onContentChange={handleNoteContentChange}
                onSave={handleNoteSave}
                monacoTheme={monacoTheme}
                editorFontFamily={config?.settings?.fonts?.codeFont}
                editorFontSize={config?.settings?.editor?.fontSize}
                editorWordWrap={config?.settings?.editor?.wordWrap}
              />
            </div>
          )}
        </div>


      </main>

      {scriptDialog && currentKernelId && (
        <ScriptDialog
          node={scriptDialog}
          kernelId={currentKernelId}
          onRun={handleScriptRun}
          onCancel={() => setScriptDialog(null)}
        />
      )}

      {renameTarget !== null && currentKernelId && (
        <RenameDialog
          currentKey={renameTarget.key}
          nodePath={renameTarget.path}
          onCancel={() => setRenameTarget(null)}
          onRename={(newName) => void runTreeAction(
            () => window.pdv.tree.rename(currentKernelId, renameTarget.path, newName),
            () => setRenameTarget(null),
          )}
        />
      )}

      {moveTarget !== null && currentKernelId && (
        <MoveDialog
          currentPath={moveTarget.path}
          nodeType={moveTarget.type}
          kernelId={currentKernelId}
          onCancel={() => setMoveTarget(null)}
          onMove={(newPath) => void runTreeAction(
            () => window.pdv.tree.move(currentKernelId, moveTarget.path, newPath),
            () => setMoveTarget(null),
          )}
        />
      )}

      {duplicateTarget !== null && currentKernelId && (
        <DuplicateDialog
          currentPath={duplicateTarget.path}
          nodeType={duplicateTarget.type}
          onCancel={() => setDuplicateTarget(null)}
          onDuplicate={(newPath) => void runTreeAction(
            () => window.pdv.tree.duplicate(currentKernelId, duplicateTarget.path, newPath),
            () => setDuplicateTarget(null),
          )}
        />
      )}

      {createNodeTarget !== null && currentKernelId && (
        <CreateNodeDialog
          parentPath={createNodeTarget}
          onCancel={() => setCreateNodeTarget(null)}
          onCreate={(name) => void runTreeAction(
            () => window.pdv.tree.createNode(currentKernelId, createNodeTarget, name),
            () => setCreateNodeTarget(null),
          )}
        />
      )}

      {createScriptTarget !== null && currentKernelId && (
        <CreateScriptDialog
          parentPath={createScriptTarget}
          onCancel={() => setCreateScriptTarget(null)}
          onCreate={async (name) => {
            try {
              const result = await window.pdv.tree.createScript(currentKernelId, createScriptTarget, name);
              if (!result.success) {
                setLastError(result.error);
              } else if (result.treePath) {
                setTreeRefreshToken((t) => t + 1);
                await window.pdv.script.edit(currentKernelId, result.treePath);
              }
            } catch (error) {
              setLastError(error instanceof Error ? error.message : String(error));
            } finally {
              setCreateScriptTarget(null);
            }
          }}
        />
      )}

      {createNoteTarget !== null && currentKernelId && (
        <CreateNoteDialog
          parentPath={createNoteTarget}
          onCancel={() => setCreateNoteTarget(null)}
          onCreate={async (name) => {
            try {
              const result = await window.pdv.tree.createNote(currentKernelId, createNoteTarget, name);
              if (!result.success) {
                setLastError(result.error);
              } else if (result.treePath) {
                setTreeRefreshToken((t) => t + 1);
                const noteNode: TreeNodeData = {
                  id: result.treePath,
                  key: name,
                  path: result.treePath,
                  type: 'markdown',
                  preview: '',
                  hasChildren: false,
                  parentPath: createNoteTarget || null,
                };
                await openNote(noteNode);
              }
            } catch (error) {
              setLastError(error instanceof Error ? error.message : String(error));
            } finally {
              setCreateNoteTarget(null);
            }
          }}
        />
      )}

      {createGuiTarget !== null && currentKernelId && (
        <CreateGuiDialog
          parentPath={createGuiTarget}
          onCancel={() => setCreateGuiTarget(null)}
          onCreate={async (name) => {
            try {
              const result = await window.pdv.tree.createGui(currentKernelId, createGuiTarget, name);
              if (!result.success) {
                setLastError(result.error);
              } else if (result.treePath) {
                setTreeRefreshToken((t) => t + 1);
                void window.pdv.guiEditor.open({ treePath: result.treePath, kernelId: currentKernelId });
              }
            } catch (error) {
              setLastError(error instanceof Error ? error.message : String(error));
            } finally {
              setCreateGuiTarget(null);
            }
          }}
        />
      )}

      {createLibTarget !== null && currentKernelId && (
        <CreateLibDialog
          parentPath={createLibTarget}
          onCancel={() => setCreateLibTarget(null)}
          onCreate={async (name) => {
            try {
              const result = await window.pdv.tree.createLib(currentKernelId, createLibTarget, name);
              if (!result.success) {
                setLastError(result.error);
              } else if (result.treePath) {
                setTreeRefreshToken((t) => t + 1);
                await window.pdv.script.edit(currentKernelId, result.treePath);
              }
            } catch (error) {
              setLastError(error instanceof Error ? error.message : String(error));
            } finally {
              setCreateLibTarget(null);
            }
          }}
        />
      )}

      <NewModuleDialog
        isOpen={showNewModuleDialog}
        defaultLanguage={activeLanguage === 'julia' ? 'julia' : 'python'}
        onCancel={() => setShowNewModuleDialog(false)}
        onCreated={() => {
          setShowNewModuleDialog(false);
          setTreeRefreshToken((t) => t + 1);
        }}
      />

      {moduleMetadataTarget && (
        <ModuleMetadataDialog
          isOpen={true}
          alias={moduleMetadataTarget.alias}
          initial={{
            name: moduleMetadataTarget.name,
            version: moduleMetadataTarget.version,
            description: moduleMetadataTarget.description,
            language: moduleMetadataTarget.language,
          }}
          onCancel={() => setModuleMetadataTarget(null)}
          onSaved={() => {
            setModuleMetadataTarget(null);
            setTreeRefreshToken((t) => t + 1);
          }}
        />
      )}

      {/* Status bar */}
        <StatusBar
          isExecuting={isExecuting}
          activeLanguage={activeLanguage}
          environmentMode={environmentMode}
          pythonPath={config?.pythonPath}
          juliaPath={config?.juliaPath}
          kernelSpec={config?.kernelSpec ?? undefined}
          currentProjectDir={currentProjectDir}
          kernelStatus={kernelStatus}
          lastDuration={lastDuration}
          progress={progress}
          onRuntimeClick={() => { setSettingsInitialTab('runtime'); setShowSettings(true); }}
          onRestartSession={handleRestartKernel}
          canRestart={currentKernelId !== null}
          lastChecksum={lastChecksum}
          checksumMismatch={checksumMismatch}
          savedPdvVersion={savedPdvVersion}
          runningPdvVersion={runningPdvVersion}
          lastAutosaveAt={lastAutosaveAt}
          kernelMemoryRss={kernelMemoryRss}
          updateStatus={updateStatus}
          onUpdateClick={() => { setSettingsInitialTab('about'); setShowSettings(true); }}
          mcpClientAttached={mcpClientAttached}
        />

       <ImportModuleDialog
         isOpen={showImportModule}
         projectDir={currentProjectDir}
         activeLanguage={activeLanguage}
         refreshToken={modulesRefreshToken}
         onClose={() => setShowImportModule(false)}
       />
       {showSaveAsDialog && (
         <SaveAsDialog
           defaultLocation={currentProjectDir
             ? currentProjectDir.replace(/\/[^/]+\/?$/, '')
             : config?.defaultSaveLocation ?? null}
           defaultName={currentProjectName ?? undefined}
           onSave={async (projectName, saveDir) => {
             setShowSaveAsDialog(false);
             await handleSaveProject({ directory: saveDir, projectName });
           }}
           onCancel={() => setShowSaveAsDialog(false)}
         />
       )}
       <SettingsDialog
         isOpen={showSettings}
         initialTab={settingsInitialTab}
         activeLanguage={activeLanguage}
         environmentMode={environmentMode}
         kernelRunning={currentKernelId !== null && kernelStatus === 'ready'}
         config={config}
         shortcuts={shortcuts}
         onClose={() => setShowSettings(false)}
         onSave={handleSettingsSave}
         onEnvSave={(paths) => {
           if (currentKernelId !== null && kernelStatus === 'ready') {
             // A session is running: the selection only updates the global
             // default runtime for future sessions (§10.5.19) — no kernel
             // stop, no dirty guard, and the live project keeps its
             // environment.
             setInterpreterWarning(null);
             setShowSettings(false);
             void handleEnvSave(paths, { restart: false });
             return;
           }
           guardDirty('change the interpreter', () => {
             setShowSettings(false);
             setInterpreterWarning(null);
             void handleEnvSave(paths).then((ok) => {
               if (!ok) {
                 openEnvSettings(lastErrorRef.current ?? 'Kernel failed to start with the selected environment.');
               }
             });
           });
         }}
         onInstallUpdate={() => {
           // Don't guard here — the main-process close intercept will run
           // its own dirty prompt as part of the quit sequence triggered by
           // installUpdate(). Prompting in both places caused a double
           // dialog and broke the welcome-screen quit path.
           void window.pdv.updater.installUpdate();
         }}
         envWarning={interpreterWarning}
       />

       {((showWelcome && isPristine) || forceWelcome) && (
         <WelcomeScreen
           recentProjects={recentProjects}
           recoverableSessions={recoverableSessions}
           onNewProject={handleWelcomeNewProject}
           onOpenProject={handleOpenWithPicker}
           onOpenRecent={handleOpenRecent}
           onRecoverSession={handleRecoverSession}
           onDiscardSession={handleDiscardSession}
           onClearRecents={handleClearRecents}
         />
       )}

       {showNewProjectDialog && (
         <NewProjectDialog
           defaultPackages={config?.defaultPackages ?? []}
           currentPythonPath={config?.pythonPath}
           onCreateUv={(opts) => void handleNewProjectCreateUv(opts)}
           onCreateShared={(pythonPath) => void handleNewProjectCreateShared(pythonPath)}
           onCancel={() => setShowNewProjectDialog(false)}
         />
       )}

       {pendingDirtyAction && (
         <UnsavedChangesDialog
           actionLabel={pendingDirtyAction.label}
           onSave={async () => {
             const action = pendingDirtyAction.run;
             setPendingDirtyAction(null);
             const saved = await handleSaveProject();
             if (saved) {
               action();
             }
           }}
           onDiscard={() => {
             const action = pendingDirtyAction.run;
             setPendingDirtyAction(null);
             action();
           }}
           onCancel={() => setPendingDirtyAction(null)}
         />
       )}
     </div>
   );
};

/** Default export for renderer bootstrap (`main.tsx`). */
export default App;
