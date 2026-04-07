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
import { CreateGuiDialog } from '../components/Tree/CreateGuiDialog';
import { CreateNoteDialog } from '../components/Tree/CreateNoteDialog';
import { TitleBar } from '../components/TitleBar';
import { WriteTab } from '../components/WriteTab';
import { SettingsDialog } from '../components/SettingsDialog';
import { ImportModuleDialog } from '../components/ImportModuleDialog';
import { SaveAsDialog } from '../components/SaveAsDialog';
import { WelcomeScreen, type RecentProject } from '../components/WelcomeScreen';
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
import { normalizeLoadedCodeCells, normalizeRecentProjects, mergeConfigUpdate } from './app-utils';
import { CELL_UNDO_LIMIT, NAMESPACE_REFRESH_INTERVAL_MS } from './constants';
import { useCodeCellsPersistence } from './useCodeCellsPersistence';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useKernelLifecycle } from './useKernelLifecycle';
import { useLayoutState } from './useLayoutState';
import { useProjectWorkflow } from './useProjectWorkflow';
import { useKernelSubscriptions } from './useKernelSubscriptions';
import { useThemeManager } from './useThemeManager';

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
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [codeCellExecutionError, setCodeCellExecutionError] =
    useState<CodeCellExecutionError | undefined>(undefined);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [lastChecksum, setLastChecksum] = useState<string | null>(null);
  const [checksumMismatch, setChecksumMismatch] = useState<boolean>(false);
  const [savedPdvVersion, setSavedPdvVersion] = useState<string | null>(null);
  const [runningPdvVersion, setRunningPdvVersion] = useState<string | null>(null);
  const [interpreterWarning, setInterpreterWarning] = useState<string | null>(null);

  // -- App / config state ---------------------------------------------------
  const [config, setConfig] = useState<Config | null>(null);
  const [currentProjectDir, setCurrentProjectDir] = useState<string | null>(null);
  const initRef = useRef(false);
  const loadedProjectTabsRef = useRef<{ tabs: CellTab[]; activeTabId: number } | null>(null);
  /** Deferred project action to execute once the kernel becomes ready. */
  const pendingProjectRef = useRef<{ type: 'open'; path?: string; language?: 'python' | 'julia' } | null>(null);

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

  // -- Dialog visibility state ----------------------------------------------

  const [showWelcome, setShowWelcome] = useState(true);
  const [forceWelcome, setForceWelcome] = useState(false);
  const [scriptDialog, setScriptDialog] = useState<TreeNodeData | null>(null);
  const [createScriptTarget, setCreateScriptTarget] = useState<string | null>(null);
  const [createNoteTarget, setCreateNoteTarget] = useState<string | null>(null);
  const [createGuiTarget, setCreateGuiTarget] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showImportModule, setShowImportModule] = useState(false);
  const [showSaveAsDialog, setShowSaveAsDialog] = useState(false);
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
    setCellTabs,
    setActiveCellTab,
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

  // Listen for File-menu actions handled at the App level.
  useEffect(() => {
    if (!window.pdv?.menu) return;
    const unsub = window.pdv.menu.onAction((payload) => {
      if (payload.action === 'modules:import') {
        setShowImportModule(true);
      } else if (payload.action === 'settings:open') {
        setSettingsInitialTab('general');
        setShowSettings(true);
      } else if (payload.action === 'project:new') {
        setCurrentProjectName(null);
        setForceWelcome(true);
      } else if (payload.action === 'recentProjects:clear') {
        void window.pdv.config.set({ recentProjects: [] }).then((updated) => {
          if (updated) setConfig((prev) => (prev ? { ...prev, recentProjects: [] } : prev));
        });
        void window.pdv.menu.updateRecentProjects([]);
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
    });
  }, [kernelReady]);

  const currentKernelIdRef = useRef(currentKernelId);
  currentKernelIdRef.current = currentKernelId;

  const handleKernelCrash = useCallback((crashedKernelId: string) => {
    if (crashedKernelId === currentKernelIdRef.current) {
      setKernelStatus('error');
    }
  }, []);

  const handleTreeChanged = useCallback((info: TreeChangeInfo) => {
    setPendingTreeChanges((prev) => [...prev, info]);
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
  });

  const { startKernel, handleEnvSave, handleRestartKernel } = useKernelLifecycle({
    config,
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setConfig,
    setLogs,
    setNamespaceRefreshToken,
    setTreeRefreshToken,
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
      if (createScriptTarget) { setCreateScriptTarget(null); return; }
      if (createNoteTarget) { setCreateNoteTarget(null); return; }
      if (createGuiTarget) { setCreateGuiTarget(null); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSaveAsDialog, showImportModule, scriptDialog, createScriptTarget, createNoteTarget, createGuiTarget]);

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
      console.error('[App] Failed to save note:', error);
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

  const handleNoteCloseTab = (id: string) => {
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
      if (node.module_id) {
        const alias = node.type === 'gui' && node.parent_path ? node.parent_path : node.key;
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
    if (action === 'create_script') {
      setCreateScriptTarget(node.path);
    } else if (action === 'create_note') {
      setCreateNoteTarget(node.path);
    } else if (action === 'open_note' && node.type === 'markdown') {
      await openNote(node);
    } else if (action === 'run' && node.type === 'script') {
      setScriptDialog(node);
    } else if (action === 'run_defaults' && node.type === 'script') {
      if (!currentKernelId) return;
      const executionId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
    } else if (action === 'edit' && (node.type === 'script' || node.type === 'namelist' || node.type === 'lib')) {
      try {
        if (!currentKernelId) return;
        await window.pdv.script.edit(currentKernelId, node.path);
      } catch (error) {
        console.error('[App] Failed to open editor:', error);
      }
    } else if (action === 'copy_path') {
      const pyExpr = node.path
        ? node.path.split('.').reduce((acc, part) => `${acc}["${part}"]`, 'pdv_tree')
        : 'pdv_tree';
      await navigator.clipboard.writeText(pyExpr);
    } else if (action === 'handle') {
      if (!currentKernelId) return;
      const result = await window.pdv.tree.invokeHandler(currentKernelId, node.path);
      if (!result.success && result.error) {
        console.error('[App] Handler failed:', result.error);
      }
    } else if (action === 'print') {
      if (!currentKernelId) return;
      const pyExpr = node.path
        ? `pdv_tree[${JSON.stringify(node.path)}]`
        : 'pdv_tree';
      await handleExecute(`print(${pyExpr})`, {
        kind: 'unknown',
        label: `Tree print ${node.path || 'pdv_tree'}`,
      });
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
    setLogs((prev) => [...prev, logEntry]);
    if (result.error) {
      setLastError(result.error);
    }
    if (typeof result.duration === 'number') {
      setLastDuration(result.duration);
    }
    setNamespaceRefreshToken((prev) => prev + 1);
    setTreeRefreshToken((prev) => prev + 1);
    setScriptDialog(null);
  };

  const handleExecute = useCallback(async (code: string, originOverride?: KernelExecutionOrigin) => {
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
    setLogs((prev) => [
      ...prev,
      { id: executionId, timestamp: Date.now(), code, origin },
    ]);

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
      setTreeRefreshToken((prev) => prev + 1);
    }
  }, [currentKernelId, kernelStatus]);

  // Listen for execution requests from module popup windows
  useEffect(() => {
    if (!window.pdv?.moduleWindows) return;
    const unsub = window.pdv.moduleWindows.onExecuteRequest((code: string) => {
      if (!currentKernelId) return;
      void handleExecute(code);
    });
    return unsub;
  }, [currentKernelId, handleExecute]);

  // Whether the session has no user work (no project, no code, no logs, no notes).
  const isPristine = currentProjectDir === null
    && cellTabs.every((t) => !t.code.trim())
    && logs.length === 0
    && noteTabs.length === 0;

  const {
    handleSaveProject: _handleSaveProject,
    handleOpenProject: _handleOpenProject,
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

  const ensureKernel = useCallback(async (language: 'python' | 'julia' = 'python') => {
    setActiveLanguage(language);
    if (language === 'julia') {
      const ok = await startKernel(config ?? {} as Config, 'julia');
      if (!ok) openEnvSettings('Kernel failed to start.');
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
      if (!ok) openEnvSettings('Kernel failed to start.');
    }
  }, [config, runningPdvVersion, startKernel, openEnvSettings]);

  const handleWelcomeNewProject = useCallback(async (language: 'python' | 'julia') => {
    dismissWelcome();
    await ensureKernel(language);
  }, [dismissWelcome, ensureKernel]);

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
  }, [config, dismissWelcome, ensureKernel, openEnvSettings, startKernel]);

  const handleWelcomeOpen = useCallback(async () => {
    const dir = await window.pdv.files.pickDirectory();
    if (!dir) return;
    await openProjectFromWelcome(dir);
  }, [openProjectFromWelcome]);

  const handleWelcomeOpenRecent = useCallback(async (path: string) => {
    await openProjectFromWelcome(path);
  }, [openProjectFromWelcome]);

  // Execute deferred project action once the kernel becomes ready.
  useEffect(() => {
    if (kernelStatus !== 'ready' || !pendingProjectRef.current) return;
    const pending = pendingProjectRef.current;
    pendingProjectRef.current = null;
    void executeOpenProject(pending.path);
  }, [kernelStatus, executeOpenProject]);

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
                    onChangesConsumed={() => setPendingTreeChanges([])}
                    onAction={handleTreeAction}
                    shortcuts={shortcuts}

                  />
                )}
                {leftPanel === 'namespace' && (
                  <NamespaceView
                    kernelId={currentKernelId}
                    disabled={kernelStatus !== 'ready'}
                    autoRefresh={autoRefreshNamespace}
                    refreshToken={namespaceRefreshToken}
                    refreshInterval={NAMESPACE_REFRESH_INTERVAL_MS}
                    onToggleAutoRefresh={setAutoRefreshNamespace}
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
                <Console logs={logs} onClear={handleClearConsole} />
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
                      onClear={handleClearCommand}
                      isExecuting={isExecuting}
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

      {createScriptTarget !== null && currentKernelId && (
        <CreateScriptDialog
          parentPath={createScriptTarget}
          onCancel={() => setCreateScriptTarget(null)}
          onCreate={async (name) => {
            try {
              const result = await window.pdv.tree.createScript(currentKernelId, createScriptTarget, name);
              if (!result.success) {
                setLastError(result.error);
              } else if (result.scriptPath) {
                await window.pdv.script.edit(currentKernelId, result.scriptPath);
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
                  parent_path: createNoteTarget || null,
                  type: 'markdown',
                  has_children: false,
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

      {/* Status bar */}
        <StatusBar
          isExecuting={isExecuting}
          activeLanguage={activeLanguage}
          pythonPath={config?.pythonPath}
          juliaPath={config?.juliaPath}
          kernelSpec={config?.kernelSpec ?? undefined}
          currentProjectDir={currentProjectDir}
          kernelStatus={kernelStatus}
          lastDuration={lastDuration}
          progress={progress}
          onRuntimeClick={() => { setSettingsInitialTab('runtime'); setShowSettings(true); }}
          lastChecksum={lastChecksum}
          checksumMismatch={checksumMismatch}
          savedPdvVersion={savedPdvVersion}
          runningPdvVersion={runningPdvVersion}
        />

       <ImportModuleDialog
         isOpen={showImportModule}
         projectDir={currentProjectDir}
         kernelReady={kernelStatus === 'ready'}
         activeLanguage={activeLanguage}
         refreshToken={modulesRefreshToken}
         onClose={() => setShowImportModule(false)}
       />
       {showSaveAsDialog && (
         <SaveAsDialog
           defaultLocation={currentProjectDir
             ? currentProjectDir.replace(/\/[^/]+\/?$/, '')
             : null}
           defaultName={currentProjectName ?? undefined}
           onSave={async (projectName, saveDir) => {
             setShowSaveAsDialog(false);
             await _handleSaveProject({ directory: saveDir, projectName });
           }}
           onCancel={() => setShowSaveAsDialog(false)}
         />
       )}
       <SettingsDialog
         isOpen={showSettings}
         initialTab={settingsInitialTab}
         activeLanguage={activeLanguage}
         config={config}
         shortcuts={shortcuts}
         onClose={() => setShowSettings(false)}
         onSave={handleSettingsSave}
         onEnvSave={async (paths) => {
           setShowSettings(false);
           setInterpreterWarning(null);
           const ok = await handleEnvSave(paths);
           if (!ok) {
             openEnvSettings('Kernel failed to start with the selected environment.');
           }
         }}
         envWarning={interpreterWarning}
       />

       {((showWelcome && isPristine) || forceWelcome) && (
         <WelcomeScreen
           recentProjects={recentProjects}
           onNewProject={handleWelcomeNewProject}
           onOpenProject={handleWelcomeOpen}
           onOpenRecent={handleWelcomeOpenRecent}
         />
       )}
     </div>
   );
};

/** Default export for renderer bootstrap (`main.tsx`). */
export default App;
