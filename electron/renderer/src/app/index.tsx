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
import { EnvironmentSelector } from '../components/EnvironmentSelector';
import { NamespaceView } from '../components/NamespaceView';
import { ModulesPanel } from '../components/ModulesPanel';
import { ScriptDialog } from '../components/ScriptDialog';
import { CreateScriptDialog } from '../components/Tree/CreateScriptDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import type { CellTab, Config, KernelExecuteResult, LogEntry, MenuActionPayload, TreeNodeData } from '../types';
import { matchesShortcut, resolveShortcuts } from '../shortcuts';
import { BUILTIN_THEMES, applyThemeColors, applyFontSettings, getMonacoTheme, resolveThemeColors } from '../themes';

type KernelStatus = 'idle' | 'starting' | 'ready' | 'error';

/**
 * Normalize persisted code-cell payloads from config/project files into a safe
 * runtime shape expected by the renderer.
 */
function normalizeLoadedCodeCells(data: unknown): { tabs: CellTab[]; activeTabId: number } {
  const rawTabs =
    Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { tabs?: unknown }).tabs)
        ? ((data as { tabs: unknown[] }).tabs)
        : [];

  const tabs = rawTabs
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const maybe = entry as Record<string, unknown>;
      const code = typeof maybe.code === 'string' ? maybe.code : '';
      const id = typeof maybe.id === 'number' ? maybe.id : index + 1;
      return { id, code };
    })
    .filter((tab): tab is CellTab => tab !== null);
  const normalizedTabs = tabs.length > 0 ? tabs : [{ id: 1, code: '' }];
  const requestedActive =
    data && typeof data === 'object' && typeof (data as { activeTabId?: unknown }).activeTabId === 'number'
      ? (data as { activeTabId: number }).activeTabId
      : normalizedTabs[0].id;
  const activeTabId = normalizedTabs.some((tab) => tab.id === requestedActive)
    ? requestedActive
    : normalizedTabs[0].id;
  return { tabs: normalizedTabs, activeTabId };
}

/** Normalize the recent-project list (unique, trimmed, max 10 entries). */
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


/** Root PDV application component rendered in the Electron renderer process. */
const App: React.FC = () => {
  // Layout state — activity bar + collapsible sidebars
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(() => localStorage.getItem('pdv.layout.leftSidebarOpen') !== 'false');
  const [leftPanel, setLeftPanel] = useState<'tree' | 'namespace'>(() => (localStorage.getItem('pdv.layout.leftPanel') as 'tree' | 'namespace') || 'tree');
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => localStorage.getItem('pdv.layout.rightSidebar') !== 'false');
  const [rightPanel, setRightPanel] = useState<'library' | 'imported'>(() => (localStorage.getItem('pdv.layout.rightPanel') as 'library' | 'imported') || 'imported');
  const [editorCollapsed, setEditorCollapsed] = useState(() => localStorage.getItem('pdv.layout.editorCollapsed') === 'true');

  const [CellTabs, setCellTabs] = useState<CellTab[]>([{ id: 1, code: '' }]);
  const [activeCellTab, setActiveCellTab] = useState(1);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentKernelId, setCurrentKernelId] = useState<string | null>(null);
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>('idle');
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [showEnvSelector, setShowEnvSelector] = useState(false);
  const [scriptDialog, setScriptDialog] = useState<TreeNodeData | null>(null);
  const [currentProjectDir, setCurrentProjectDir] = useState<string | null>(null);
  const initRef = useRef(false);
  const loadedProjectTabsRef = useRef<{ tabs: CellTab[]; activeTabId: number } | null>(null);

  // Undo stack for cell clear/close. Each entry captures the full tab list and
  // active tab id so a single Cmd+Z restores exactly what was destroyed.
  type CellSnapshot = { tabs: CellTab[]; activeTabId: number };
  const cellUndoStack = useRef<CellSnapshot[]>([]);
  const [leftWidth, setLeftWidth] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.leftWidth');
    return saved ? Number(saved) : 340;
  });
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.rightWidth');
    return saved ? Number(saved) : 280;
  });
  const [editorHeight, setEditorHeight] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.editorHeight');
    return saved ? Number(saved) : 260;
  });
  const dragRef = useRef<'vertical' | 'horizontal' | 'right-vertical' | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const [autoRefreshNamespace, setAutoRefreshNamespace] = useState(false);
  const [namespaceRefreshToken, setNamespaceRefreshToken] = useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [modulesRefreshToken, setModulesRefreshToken] = useState(0);
  const [createScriptTarget, setCreateScriptTarget] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about'>('shortcuts');
  const [monacoTheme, setMonacoTheme] = useState<string>('vs-dark');
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  // Unsaved-changes dialog state.
  // reason: 'close' = window/app close, 'open' = opening another project
  const [unsavedDialogContext, setUnsavedDialogContext] = useState<
    null | { reason: 'close' | 'open'; pendingPath?: string }
  >(null);

  const shortcuts = useMemo(() => resolveShortcuts(config?.settings?.shortcuts), [config]);

  // Track system color-scheme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Apply theme whenever config or system preference changes
  useEffect(() => {
    if (!config?.settings?.appearance) return;
    const app = config.settings.appearance;
    if (app.followSystemTheme) {
      const themeName = systemPrefersDark ? app.darkTheme : app.lightTheme;
      const colors = resolveThemeColors(themeName, []);
      if (colors) {
        applyThemeColors(colors);
        setMonacoTheme(getMonacoTheme(themeName ?? '', BUILTIN_THEMES));
      }
    } else {
      if (app.colors) applyThemeColors(app.colors);
      setMonacoTheme(getMonacoTheme(app.themeName ?? '', BUILTIN_THEMES));
    }
  }, [config, systemPrefersDark]);

  // Apply font settings whenever config changes
  useEffect(() => {
    const fonts = config?.settings?.fonts;
    applyFontSettings(fonts?.codeFont, fonts?.displayFont);
  }, [config]);

  // Load code celles from filesystem on startup
  useEffect(() => {
    if (!window.pdv?.codeCells) {
      return;
    }
    const loadCodeCells = async () => {
      try {
        const data = await window.pdv.codeCells.load();
        if (data) {
          setCellTabs(data.tabs);
          setActiveCellTab(data.activeTabId);
          console.log('[App] Loaded code celles from filesystem:', data.tabs.length, 'tabs');
        }
      } catch (error) {
        console.error('[App] Failed to load code celles:', error);
      }
    };
    void loadCodeCells();
  }, []);

  // Debounced save to filesystem
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!window.pdv?.codeCells) {
      return;
    }
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce saves by 500ms to avoid excessive file writes
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await window.pdv.codeCells.save({
          tabs: CellTabs,
          activeTabId: activeCellTab,
        });
        console.log('[App] Saved code celles to filesystem');
      } catch (error) {
        console.error('[App] Failed to save code celles:', error);
      }
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        // Save immediately on cleanup to avoid data loss
        void window.pdv.codeCells.save({
          tabs: CellTabs,
          activeTabId: activeCellTab,
        });
      }
    };
  }, [CellTabs, activeCellTab]);

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

        if (!loaded.pythonPath) {
          setKernelStatus('idle');
          setShowEnvSelector(true);
          return;
        }

        await startKernel(loaded);
      } catch (error) {
        console.error('[App] Failed to load config:', error);
        setKernelStatus('error');
        setLastError(error instanceof Error ? error.message : String(error));
        setShowEnvSelector(true);
      }
    };

    void initConfig();
  }, []);

  useEffect(() => {
    const projectName = currentProjectDir
      ? currentProjectDir.split('/').filter(Boolean).pop() ?? 'Unsaved Project'
      : 'Unsaved Project';
    document.title = `PDV: ${projectName}`;
  }, [currentProjectDir]);

  const addCellTabRef = useRef<() => void>(null!);
  useEffect(() => {
    addCellTabRef.current = addCellTab;
  });

  const activeCellTabRef = useRef(activeCellTab);
  useEffect(() => {
    activeCellTabRef.current = activeCellTab;
  }, [activeCellTab]);

  const cellTabsRef = useRef(CellTabs);
  useEffect(() => {
    cellTabsRef.current = CellTabs;
  }, [CellTabs]);

  const removeCellTabRef = useRef<(id: number) => void>(null!);
  useEffect(() => {
    removeCellTabRef.current = handleRemoveCellTab;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      // Cmd+Z outside Monaco → undo last cell clear/close
      // Monaco sets its editor textarea as the active element; when it has focus
      // it handles Cmd+Z itself before this listener sees it.
      const isMonacoFocused = (document.activeElement as HTMLElement)
        ?.closest('.monaco-editor') != null;
      if (!isMonacoFocused && (event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey && !event.altKey) {
        const snapshot = cellUndoStack.current[cellUndoStack.current.length - 1];
        if (snapshot) {
          event.preventDefault();
          cellUndoStack.current = cellUndoStack.current.slice(0, -1);
          setCellTabs(snapshot.tabs);
          setActiveCellTab(snapshot.activeTabId);
        }
        return;
      }

      if (matchesShortcut(event, shortcuts.openSettings)) {
        event.preventDefault();
        setShowSettings(true);
      }
      if (matchesShortcut(event, shortcuts.newTab)) {
        event.preventDefault();
        addCellTabRef.current();
      }
      if (matchesShortcut(event, shortcuts.closeTab)) {
        event.preventDefault();
        removeCellTabRef.current(activeCellTabRef.current);
      }
      if (matchesShortcut(event, shortcuts.closeWindow)) {
        event.preventDefault();
        window.close();
      }
      // Cmd+B: toggle left sidebar
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 'b') {
        event.preventDefault();
        setLeftSidebarOpen(prev => {
          const next = !prev;
          localStorage.setItem('pdv.layout.leftSidebarOpen', String(next));
          return next;
        });
      }
      // Cmd+J: toggle code editor
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 'j') {
        event.preventDefault();
        setEditorCollapsed(prev => {
          const next = !prev;
          localStorage.setItem('pdv.layout.editorCollapsed', String(next));
          return next;
        });
      }
      // Cmd+1–9 → go to nth tab; Cmd+0 → go to last tab
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        const digit = event.key;
        if (digit >= '1' && digit <= '9') {
          event.preventDefault();
          const t = cellTabsRef.current;
          const target = t[Math.min(Number(digit) - 1, t.length - 1)];
          if (target) setActiveCellTab(target.id);
        } else if (digit === '0') {
          event.preventDefault();
          const t = cellTabsRef.current;
          if (t.length) setActiveCellTab(t[t.length - 1].id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts]);

  useEffect(() => {
    if (!window.pdv?.menu) {
      return;
    }
    const recentProjects = normalizeRecentProjects(config?.recentProjects);
    void window.pdv.menu.updateRecentProjects(recentProjects);
  }, [config]);

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
  }, []);

  useEffect(() => {
    if (!currentKernelId) {
      return;
    }

    const unsubscribeTree = window.pdv.tree.onChanged((payload) => {
      setTreeRefreshToken((prev) => prev + 1);
      // When a tree node is removed, check if it corresponds to an imported
      // module alias and remove it from the modules manifest.
      if (payload.change_type === "removed" && payload.changed_paths.length > 0) {
        for (const removedPath of payload.changed_paths) {
          // Module aliases are top-level tree paths (no dots).
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

    return () => {
      unsubscribeTree();
      unsubscribeProject();
    };
  }, [currentKernelId]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      if (dragRef.current === 'vertical') {
        const viewportWidth = window.innerWidth || 1200;
        const max = Math.max(200, viewportWidth - 300);
        const next = Math.min(Math.max(event.clientX, 200), max);
        setLeftWidth(next);
        localStorage.setItem('pdv.pane.leftWidth', String(next));
      } else if (dragRef.current === 'horizontal') {
        const bounds = rightPaneRef.current?.getBoundingClientRect();
        if (!bounds) return;
        // Editor is at the bottom, so measure from the bottom of the center column
        const relativeY = bounds.bottom - event.clientY;
        const min = 140;
        const max = Math.max(min, bounds.height - 180);
        const next = Math.min(Math.max(relativeY, min), max);
        setEditorHeight(next);
        localStorage.setItem('pdv.pane.editorHeight', String(next));
      } else if (dragRef.current === 'right-vertical') {
        const viewportWidth = window.innerWidth || 1200;
        const min = 150;
        const max = Math.max(min, viewportWidth - 400);
        const next = Math.min(Math.max(viewportWidth - event.clientX, min), max);
        setRightWidth(next);
        localStorage.setItem('pdv.pane.rightWidth', String(next));
      }
    };

    const handleUp = () => {
      dragRef.current = null;
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const startVerticalDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = 'vertical';
  }, []);

  const startHorizontalDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = 'horizontal';
  }, []);

  const startRightDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = 'right-vertical';
  }, []);

  const handleActivityBarClick = useCallback((panel: 'tree' | 'namespace' | 'library' | 'imported') => {
    if (panel === 'library' || panel === 'imported') {
      if (rightSidebarOpen && rightPanel === panel) {
        setRightSidebarOpen(false);
        localStorage.setItem('pdv.layout.rightSidebar', 'false');
      } else {
        setRightPanel(panel);
        setRightSidebarOpen(true);
        localStorage.setItem('pdv.layout.rightPanel', panel);
        localStorage.setItem('pdv.layout.rightSidebar', 'true');
      }
    } else {
      if (leftSidebarOpen && leftPanel === panel) {
        setLeftSidebarOpen(false);
        localStorage.setItem('pdv.layout.leftSidebarOpen', 'false');
      } else {
        setLeftPanel(panel);
        setLeftSidebarOpen(true);
        localStorage.setItem('pdv.layout.leftPanel', panel);
        localStorage.setItem('pdv.layout.leftSidebarOpen', 'true');
      }
    }
  }, [leftSidebarOpen, leftPanel, rightSidebarOpen, rightPanel]);

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
  }, [config]);

  const startKernel = async (cfg: Config) => {
    setKernelStatus('starting');
    setLastError(undefined);
    try {
      console.log('[App] Starting kernel with config:', cfg);
      if (currentKernelId) {
        console.log('[App] Stopping existing kernel:', currentKernelId);
        await window.pdv.kernels.stop(currentKernelId);
      }

      const spec = {
        language: 'python' as const,
        argv: cfg.pythonPath ? [cfg.pythonPath, '-m', 'ipykernel_launcher', '-f', '{connection_file}'] : undefined,
        env: cfg.pythonPath ? { PYTHON_PATH: cfg.pythonPath } : undefined,
      };
      console.log('[App] Kernel spec:', spec);

      const kernel = await window.pdv.kernels.start(spec);
      setCurrentKernelId(kernel.id);
      setTreeRefreshToken((prev) => prev + 1);
      setNamespaceRefreshToken((prev) => prev + 1);
      setKernelStatus('ready');
      console.log('[App] Kernel started successfully:', kernel);
    } catch (error) {
      console.error('[App] Failed to start kernel:', error);
      setCurrentKernelId(null);
      setKernelStatus('error');
      setLastError(error instanceof Error ? error.message : String(error));
      setShowEnvSelector(true);
    }
  };

  const handleEnvSave = async (paths: { pythonPath: string; juliaPath?: string }) => {
    const updatedConfig: Config = {
      kernelSpec: config?.kernelSpec ?? null,
      cwd: config?.cwd ?? '',
      trusted: config?.trusted ?? false,
      recentProjects: config?.recentProjects ?? [],
      customKernels: config?.customKernels ?? [],
      pythonPath: paths.pythonPath,
      juliaPath: paths.juliaPath ?? config?.juliaPath,
      editors: config?.editors,
      treeRoot: config?.treeRoot,
      settings: config?.settings,
    };

    await window.pdv.config.set(updatedConfig);
    setConfig(updatedConfig);
    setShowEnvSelector(false);
    await startKernel(updatedConfig);
  };

  const handleRestartKernel = async () => {
    if (!currentKernelId) return;

    try {
      setKernelStatus('starting');
      setLastError(undefined);
      console.log('[App] Restarting kernel:', currentKernelId);
      const newKernel = await window.pdv.kernels.restart(currentKernelId);
      setCurrentKernelId(newKernel.id);
      setKernelStatus('ready');
      setShowEnvSelector(false);
      setLogs([]);
      setNamespaceRefreshToken((prev) => prev + 1);
      setTreeRefreshToken((prev) => prev + 1);
      console.log('[App] Kernel restarted successfully:', newKernel);
    } catch (error) {
      console.error('[App] Failed to restart kernel:', error);
      setKernelStatus('error');
      setLastError(error instanceof Error ? error.message : String(error));
    }
  };

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
  };

  const handleClearConsole = () => {
    setLogs([]);
    setLastDuration(null);
  };

  const handleClearCommand = () => {
    // Snapshot before clearing so Cmd+Z can restore
    cellUndoStack.current = [
      ...cellUndoStack.current,
      { tabs: CellTabs, activeTabId: activeCellTab },
    ].slice(-20); // keep at most 20 levels
    setCellTabs((prev) =>
      prev.map((tab) => (tab.id === activeCellTab ? { ...tab, code: '' } : tab)),
    );
    setLastError(undefined);
  };

  const handleRemoveCellTab = (id: number) => {
    // Snapshot before closing so Cmd+Z can restore
    cellUndoStack.current = [
      ...cellUndoStack.current,
      { tabs: CellTabs, activeTabId: activeCellTab },
    ].slice(-20);
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
    setLastError(undefined);
  };

  const handleSettingsSave = async (updates: Partial<Config>) => {
    await window.pdv.config.set(updates);
    const mergedConfig = config ? { ...config, ...updates, settings: { ...config.settings, ...updates.settings, appearance: { ...config.settings?.appearance, ...updates.settings?.appearance } } } : null;
    setConfig(mergedConfig);  // reactive effect applies theme
    if (
      mergedConfig &&
      ((updates.pythonPath && updates.pythonPath !== config?.pythonPath) ||
        (updates.juliaPath && updates.juliaPath !== config?.juliaPath))
    ) {
      await startKernel(mergedConfig);
    }
    setShowSettings(false);
  };

  const handleTreeAction = async (action: string, node: TreeNodeData) => {
    console.log('[App] Tree action:', action, node);

    if (action === 'create_script') {
      setCreateScriptTarget(node.path);
    } else if (action === 'run' && node.type === 'script') {
      setScriptDialog(node);
    } else if ((action === 'edit' || action === 'view_source') && node.type === 'script') {
      try {
        if (!currentKernelId) return;
        await window.pdv.script.edit(currentKernelId, node.path);
      } catch (error) {
        console.error('[App] Failed to open editor:', error);
      }
    } else if (action === 'reload' && node.type === 'script') {
      await window.pdv.script.reload(node.path);
    } else if (action === 'copy_path') {
      await navigator.clipboard.writeText(
        node.path.split('.').reduce((acc, part) => `${acc}["${part}"]`, 'pdv_tree'),
      );
    } else if (action === 'print') {
      if (!currentKernelId) return;
      const target = JSON.stringify(node.path);
      await handleExecute(`print(pdv_tree[${target}])`);
    }
  };

  const handleScriptRun = (code: string, result: KernelExecuteResult) => {
    const logEntry: LogEntry = {
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      code,
      stdout: result.stdout,
      stderr: result.stderr,
      result: result.result,
      error: result.error,
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
    setScriptDialog(null);
  };

  const handleExecute = async (code: string) => {
    if (!currentKernelId || kernelStatus !== 'ready' || !code.trim()) return;

    setIsExecuting(true);
    setLastError(undefined);

    const executionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Create the log entry immediately so output appears as it streams in.
    setLogs((prev) => [...prev, { id: executionId, timestamp: Date.now(), code }]);

    try {
      const result = await window.pdv.kernels.execute(currentKernelId, { code, executionId });

      // Finalize the entry with duration and any error (stdout/stderr already streamed).
      setLogs((prev) =>
        prev.map((l) =>
          l.id === executionId
            ? { ...l, error: result.error, duration: result.duration }
            : l
        )
      );

      if (result.error) {
        setLastError(result.error);
      }
      if (typeof result.duration === 'number') {
        setLastDuration(result.duration);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLogs((prev) =>
        prev.map((l) => (l.id === executionId ? { ...l, error: msg } : l))
      );
      setLastError(msg);
    } finally {
      setIsExecuting(false);
      setNamespaceRefreshToken((prev) => prev + 1);
    }
  };

  const handleSaveProject = useCallback(async (options?: { saveAs?: boolean; directory?: string }) => {
    if (kernelStatus !== 'ready') {
      return;
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
        return;
      }
      await window.pdv.project.save(saveDir, {
        tabs: CellTabs,
        activeTabId: activeCellTab,
      });
      setCurrentProjectDir(saveDir);
      setModulesRefreshToken((prev) => prev + 1);
      await rememberRecentProject(saveDir);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [activeCellTab, CellTabs, currentProjectDir, kernelStatus, rememberRecentProject]);

  // Actually load a project (no confirmation — called after unsaved dialog resolves).
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
  }, [kernelStatus, rememberRecentProject]);

  // Prompt unsaved-changes dialog before opening a project.
  const handleOpenProject = useCallback((directory?: string) => {
    setUnsavedDialogContext({ reason: 'open', pendingPath: directory });
  }, []);

  // --- Unsaved-changes dialog action handlers ---

  const handleUnsavedSave = useCallback(async () => {
    const ctx = unsavedDialogContext;
    setUnsavedDialogContext(null);
    await handleSaveProject();
    if (ctx?.reason === 'close') {
      await window.pdv.lifecycle.respondClose({ action: 'save' });
    } else if (ctx?.reason === 'open') {
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

  // Subscribe to main-process close-confirmation requests.
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

  return (
    <div className="app">
      {/* Main content */}
      <main className="app-main">

        {/* Activity bar — always visible */}
        <nav className="activity-bar">
          <div className="activity-bar-top">
            <button
              className={`activity-btn${leftSidebarOpen && leftPanel === 'tree' ? ' active' : ''}`}
              onClick={() => handleActivityBarClick('tree')}
              title="Tree (Cmd+B)"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="3" x2="4" y2="17" />
                <line x1="4" y1="6" x2="10" y2="6" />
                <line x1="4" y1="11" x2="10" y2="11" />
                <line x1="4" y1="16" x2="10" y2="16" />
                <rect x="10" y="4" width="6" height="4" rx="1" />
                <rect x="10" y="9" width="6" height="4" rx="1" />
                <rect x="10" y="14" width="6" height="4" rx="1" />
              </svg>
            </button>
            <button
              className={`activity-btn${leftSidebarOpen && leftPanel === 'namespace' ? ' active' : ''}`}
              onClick={() => handleActivityBarClick('namespace')}
              title="Namespace"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 4C5.5 4 4.5 5 4.5 6.5v2C4.5 10 3.8 10.5 2 11c1.8 0.5 2.5 1 2.5 2.5v2C4.5 17 5.5 16 7 16" />
                <path d="M13 4c1.5 0 2.5 1 2.5 2.5v2C15.5 10 16.2 10.5 18 11c-1.8 0.5-2.5 1-2.5 2.5v2C15.5 17 14.5 16 13 16" />
                <circle cx="10" cy="11" r="1.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button
              className={`activity-btn${rightSidebarOpen && rightPanel === 'imported' ? ' active' : ''}`}
              onClick={() => handleActivityBarClick('imported')}
              title="Modules"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16,6.5 10,3.5 4,6.5 10,9.5 16,6.5" />
                <polyline points="4,6.5 4,13.5 10,16.5 10,9.5" />
                <polyline points="16,6.5 16,13.5 10,16.5" />
              </svg>
            </button>
            <button
              className={`activity-btn${rightSidebarOpen && rightPanel === 'library' ? ' active' : ''}`}
              onClick={() => handleActivityBarClick('library')}
              title="Module Library"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4,11 4,16 16,16 16,11" />
                <line x1="2" y1="11" x2="18" y2="11" />
                <line x1="10" y1="3" x2="10" y2="9" />
                <polyline points="7,6 10,9 13,6" />
              </svg>
            </button>
          </div>
          <div className="activity-bar-bottom">
            <button
              className="activity-btn"
              onClick={() => { setSettingsInitialTab('general'); setShowSettings(true); }}
              title="Settings"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="10" cy="10" r="2.5" />
                <path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.4 4.4l1.1 1.1M14.5 14.5l1.1 1.1M4.4 15.6l1.1-1.1M14.5 5.5l1.1-1.1" />
              </svg>
            </button>
          </div>
        </nav>

        {/* Left sidebar — collapsible */}
        {leftSidebarOpen && (
          <>
            <aside className="left-sidebar" style={{ width: `${leftWidth}px` }}>
              <div className="sidebar-header">
                <span className="sidebar-title">{leftPanel === 'tree' ? 'Tree' : 'Namespace'}</span>
                <button
                  className="sidebar-collapse-btn"
                  onClick={() => { setLeftSidebarOpen(false); localStorage.setItem('pdv.layout.leftSidebarOpen', 'false'); }}
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
                    refreshInterval={2000}
                    onToggleAutoRefresh={setAutoRefreshNamespace}
                  />
                )}
              </div>
            </aside>
            <div className="vertical-resizer" onMouseDown={startVerticalDrag} />
          </>
        )}

        {/* Center column: console on top, code editor at bottom */}
        <div className="center-column" ref={rightPaneRef}>
          <div className="console-wrapper">
            <div className="console-header">
              <span className="console-header-title">Console</span>
            </div>
            <Console logs={logs} onClear={handleClearConsole} />
          </div>
          {editorCollapsed ? (
            <div
              className="editor-collapsed-bar"
              onClick={() => { setEditorCollapsed(false); localStorage.setItem('pdv.layout.editorCollapsed', 'false'); }}
            >
              ▲ Editor
            </div>
          ) : (
            <>
              <div className="horizontal-resizer" onMouseDown={startHorizontalDrag} />
              <div className="editor-wrapper" style={{ height: `${editorHeight}px` }}>
                <CodeCell
                  tabs={CellTabs.map((tab) => ({
                    ...tab,
                    onChange: (code: string) => handleCodeChange(tab.id, code),
                  }))}
                  activeTabId={activeCellTab}
                  disabled={kernelStatus !== 'ready'}
                  onTabChange={handleTabChange}
                  onAddTab={addCellTab}
                  onRemoveTab={handleRemoveCellTab}
                  onExecute={handleExecute}
                  onClear={handleClearCommand}
                  isExecuting={isExecuting}
                  lastError={lastError}
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
        </div>

        {/* Right sidebar — collapsible (Modules) */}
        {rightSidebarOpen && (
          <>
            <div className="vertical-resizer" onMouseDown={startRightDrag} />
            <aside className="right-sidebar" style={{ width: `${rightWidth}px` }}>
              <div className="sidebar-header">
                <span className="sidebar-title">{rightPanel === 'library' ? 'Module Library' : 'Modules'}</span>
                <button
                  className="sidebar-collapse-btn"
                  onClick={() => { setRightSidebarOpen(false); localStorage.setItem('pdv.layout.rightSidebar', 'false'); }}
                  title="Collapse sidebar"
                >
                  ›
                </button>
              </div>
              <div className="sidebar-content">
                <ModulesPanel
                  projectDir={currentProjectDir}
                  isActive={rightSidebarOpen}
                  kernelId={currentKernelId}
                  kernelReady={kernelStatus === 'ready'}
                  onExecute={handleExecute}
                  view={rightPanel}
                  refreshToken={modulesRefreshToken}
                />
              </div>
            </aside>
          </>
        )}

      </main>

      {unsavedDialogContext && (
        <UnsavedChangesDialog
          onSave={() => void handleUnsavedSave()}
          onDiscard={() => void handleUnsavedDiscard()}
          onCancel={() => void handleUnsavedCancel()}
        />
      )}

      {scriptDialog && currentKernelId && (
        <ScriptDialog
          node={scriptDialog}
          kernelId={currentKernelId}
          onRun={handleScriptRun}
          onCancel={() => setScriptDialog(null)}
        />
      )}

      {createScriptTarget && currentKernelId && (
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

      {/* Status bar */}
        <footer className="status-bar">
         <div className="status-left">
           <span className="status-item">
             <span className={`status-dot ${isExecuting ? 'busy' : 'idle'}`} />
             <span>{isExecuting ? 'Busy' : 'Idle'}</span>
           </span>
           <span
             className="status-item status-clickable"
             onClick={() => { setSettingsInitialTab('runtime'); setShowSettings(true); }}
             title="Click to change runtime"
           >
             {config?.pythonPath ?? config?.kernelSpec ?? 'python3'}
           </span>
           <span className="status-item">{currentProjectDir ?? 'Unsaved Project'}</span>
         </div>
         <div className="status-right">
           <span className={`status-item ${kernelStatus === 'ready' ? 'status-connected' : kernelStatus === 'error' ? 'status-error' : ''}`}>
             ● {kernelStatus === 'ready' ? 'Connected' : kernelStatus === 'starting' ? 'Starting...' : 'Disconnected'}
           </span>
           <span className="status-item">
             Last: {lastDuration !== null ? `${Math.round(lastDuration)}ms` : '--'}
           </span>
         </div>
       </footer>

       {showEnvSelector && (
          <EnvironmentSelector
            isFirstRun={!config?.pythonPath}
            currentConfig={config || undefined}
            currentKernelId={currentKernelId}
            onSave={handleEnvSave}
           onRestart={handleRestartKernel}
           onCancel={() => setShowEnvSelector(false)}
         />
       )}
       <SettingsDialog
         isOpen={showSettings}
         initialTab={settingsInitialTab}
         config={config}
         shortcuts={shortcuts}
         currentKernelId={currentKernelId}
         onClose={() => setShowSettings(false)}
         onSave={handleSettingsSave}
         onEnvSave={handleEnvSave}
         onRestart={handleRestartKernel}
       />
     </div>
   );
};

/** Default export for renderer bootstrap (`main.tsx`). */
export default App;
