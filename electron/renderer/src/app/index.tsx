import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { CodeCell } from '../components/CodeCell';
import { Console } from '../components/Console';
import { Tree } from '../components/Tree';
import { EnvironmentSelector } from '../components/EnvironmentSelector';
import { NamespaceView } from '../components/NamespaceView';
import { ScriptDialog } from '../components/ScriptDialog';
import { CreateScriptDialog } from '../components/Tree/CreateScriptDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import type { CellTab, Config, KernelExecuteResult, LogEntry, MenuActionPayload, TreeNodeData } from '../types';
import { matchesShortcut, resolveShortcuts } from '../shortcuts';
import { BUILTIN_THEMES, applyThemeColors, applyFontSettings, getMonacoTheme, resolveThemeColors } from '../themes';

type Tab = 'tree' | 'namespace' | 'modules';
type KernelStatus = 'idle' | 'starting' | 'ready' | 'error';

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


const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('tree');
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
  const [consoleHeight, setConsoleHeight] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.consoleHeight');
    return saved ? Number(saved) : 260;
  });
  const dragRef = useRef<'vertical' | 'horizontal' | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const [autoRefreshNamespace, setAutoRefreshNamespace] = useState(false);
  const [namespaceRefreshToken, setNamespaceRefreshToken] = useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [createScriptTarget, setCreateScriptTarget] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about'>('shortcuts');
  const [monacoTheme, setMonacoTheme] = useState<string>('vs-dark');
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

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
        setCurrentProjectDir(loaded.projectRoot ?? null);

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

    const unsubscribeTree = window.pdv.tree.onChanged(() => {
      setTreeRefreshToken((prev) => prev + 1);
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
        const relativeY = event.clientY - bounds.top;
        const min = 140;
        const max = Math.max(min, bounds.height - 180);
        const next = Math.min(Math.max(relativeY, min), max);
        setConsoleHeight(next);
        localStorage.setItem('pdv.pane.consoleHeight', String(next));
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

  const rememberRecentProject = useCallback(async (projectDir: string) => {
    const recentProjects = normalizeRecentProjects(config?.recentProjects);
    const nextRecentProjects = [projectDir, ...recentProjects.filter((entry) => entry !== projectDir)].slice(0, 10);
    try {
      const updated = await window.pdv.config.set({ recentProjects: nextRecentProjects, projectRoot: projectDir });
      setConfig(updated);
    } catch {
      setConfig((prev) => (prev ? { ...prev, recentProjects: nextRecentProjects, projectRoot: projectDir } : prev));
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
      projectRoot: config?.projectRoot,
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
      await rememberRecentProject(saveDir);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [activeCellTab, CellTabs, currentProjectDir, kernelStatus, rememberRecentProject]);

  const handleOpenProject = useCallback(async (directory?: string) => {
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
      await rememberRecentProject(saveDir);
      setNamespaceRefreshToken((prev) => prev + 1);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [kernelStatus, rememberRecentProject]);

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
        {/* Left pane:  Tree */}
        <aside className="left-pane" style={{ width: `${leftWidth}px` }}>
          <div className="pane-tabs">
            <button
              className={`tab ${activeTab === 'tree' ? 'active' : ''}`}
              onClick={() => setActiveTab('tree')}
            >
              Tree
            </button>
            <button
              className={`tab ${activeTab === 'namespace' ? 'active' : ''}`}
              onClick={() => setActiveTab('namespace')}
            >
              Namespace
            </button>
            <button
              className={`tab ${activeTab === 'modules' ? 'active' : ''}`}
              onClick={() => setActiveTab('modules')}
            >
              Modules
            </button>
          </div>

          <div className="tree-panels">
            <div className={`tree-panel ${activeTab === 'namespace' ? 'active' : ''}`}>
              <NamespaceView
                kernelId={currentKernelId}
                disabled={kernelStatus !== 'ready'}
                autoRefresh={autoRefreshNamespace}
                refreshToken={namespaceRefreshToken}
                refreshInterval={2000}
                onToggleAutoRefresh={setAutoRefreshNamespace}
              />
            </div>
            <div className={`tree-panel ${activeTab === 'tree' ? 'active' : ''}`}>
              <Tree
                kernelId={currentKernelId}
                disabled={kernelStatus !== 'ready'}
                refreshToken={treeRefreshToken}
                onAction={handleTreeAction}
                shortcuts={shortcuts}
              />
            </div>
            <div className={`tree-panel ${activeTab === 'modules' ? 'active' : ''}`}>
              <div className="tree-empty">Modules view (coming soon)</div>
            </div>
          </div>
        </aside>

        {/* Vertical resizer */}
        <div className="vertical-resizer" onMouseDown={startVerticalDrag} />

        {/* Right pane: Console + Code Cell */}
        <div className="right-pane" ref={rightPaneRef}>
          <div className="console-wrapper" style={{ height: `${consoleHeight}px` }}>
            <Console logs={logs} onClear={handleClearConsole} />
          </div>

          {/* Horizontal resizer */}
          <div className="horizontal-resizer" onMouseDown={startHorizontalDrag} />

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
      </main>

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

export default App;
