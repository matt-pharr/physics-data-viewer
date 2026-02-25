import React, { useEffect, useState, useRef, useCallback } from 'react';
import { CommandBox, type DiagnosticMarker } from '../components/CommandBox';
import { Console } from '../components/Console';
import { Tree } from '../components/Tree';
import { EnvironmentSelector } from '../components/EnvironmentSelector';
import { NamespaceView } from '../components/NamespaceView';
import { ScriptDialog } from '../components/ScriptDialog';
import { CreateScriptDialog } from '../components/Tree/CreateScriptDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import type { CommandTab, Config, KernelExecuteResult, LogEntry, MenuActionPayload, TreeNodeData } from '../types';

type Tab = 'tree' | 'namespace' | 'modules';
type KernelStatus = 'idle' | 'starting' | 'ready' | 'error';
const DEFAULT_OPEN_SETTINGS_SHORTCUT = 'CommandOrControl+,';

function normalizeLoadedCommandBoxes(data: unknown): { tabs: CommandTab[]; activeTabId: number } {
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
    .filter((tab): tab is CommandTab => tab !== null);
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

function applyAppearanceColors(colors?: Record<string, string>): void {
  if (!colors) return;
  Object.entries(colors).forEach(([key, value]) => {
    document.documentElement.style.setProperty(`--${key}`, value);
  });
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  const keyPart = parts.pop();
  if (!keyPart) return false;
  const normalizedKey = keyPart === 'comma' ? ',' : keyPart;
  if (event.key.toLowerCase() !== normalizedKey) return false;
  return parts.every((part) => {
    if (part === 'commandorcontrol') return event.metaKey || event.ctrlKey;
    if (part === 'command' || part === 'cmd' || part === 'meta') return event.metaKey;
    if (part === 'control' || part === 'ctrl') return event.ctrlKey;
    if (part === 'alt' || part === 'option') return event.altKey;
    if (part === 'shift') return event.shiftKey;
    return false;
  });
}

/**
 * Encode a string to base64 in a UTF-8-safe way.
 * btoa() alone fails on non-Latin1 characters; TextEncoder gives us raw bytes.
 */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

/**
 * Build the Python diagnostic code snippet.
 *
 * Strategy (in order of preference):
 * 1. pyflakes (if installed) with kernel-namespace stubs to suppress false
 *    positives for variables defined in prior executions.
 * 2. ast.parse (always available) for syntax-only checking.
 *
 * The stub approach: before running pyflakes on the user's code, we prepend
 * `name = None` lines for every non-underscore name currently in the kernel
 * namespace. This prevents pyflakes from flagging variables like `np` or `x`
 * that were defined in earlier executions but aren't in the current buffer.
 *
 * All identifiers are _-prefixed to stay hidden from the PDV namespace panel.
 * All code runs inside try/except so it never raises.
 */
function buildDiagCode(b64: string): string {
  // _ERROR_TYPES: pyflakes message class names that are hard errors, not warnings.
  // Uses pyflakes.checker.Checker directly (not a custom Reporter class) to avoid
  // the IPython exec scoping issue where class method bodies cannot access local
  // variables from the enclosing cell scope.
  return (
    `import base64 as _b64, json as _json, ast as _ast\n` +
    `_src = _b64.b64decode("${b64}").decode("utf-8")\n` +
    `_diag = []\n` +
    `_ERROR_TYPES = {"UndefinedName","UndefinedLocal","UndefinedExport",\n` +
    `    "BreakOutsideLoop","ContinueOutsideLoop","ContinueInFinally",\n` +
    `    "DefaultExceptNotLast","TwoStarredExpressions","DuplicateArgument"}\n` +
    `try:\n` +
    `    import keyword as _kw, pyflakes.checker as _pfc\n` +
    `    _ns = get_ipython().user_ns\n` +
    `    _names = [_k for _k in _ns if not _k.startswith("_") and not _kw.iskeyword(_k)]\n` +
    `    _stub = "".join(_n + " = None\\n" for _n in _names)\n` +
    `    _stub_lines = len(_names)\n` +
    `    try:\n` +
    `        _tree = _ast.parse(_stub + _src, filename="<editor>")\n` +
    `        _chk = _pfc.Checker(_tree, filename="<editor>")\n` +
    `        for _msg in _chk.messages:\n` +
    `            _l = _msg.lineno - _stub_lines\n` +
    `            if _l < 1: continue\n` +
    `            _sev = "error" if type(_msg).__name__ in _ERROR_TYPES else "warning"\n` +
    `            _diag.append({"sl":_l,"sc":_msg.col+1,"el":_l,"ec":_msg.col+2,"msg":_msg.message % _msg.message_args,"sev":_sev})\n` +
    `    except SyntaxError as _e:\n` +
    `        _l = (_e.lineno or 1) - _stub_lines\n` +
    `        if _l >= 1:\n` +
    `            _diag.append({"sl":_l,"sc":_e.offset or 1,"el":_l,"ec":getattr(_e,"end_offset",None) or (_e.offset or 1)+1,"msg":_e.msg or "SyntaxError","sev":"error"})\n` +
    `        else:\n` +
    `            try:\n` +
    `                _ast.parse(_src, filename="<editor>")\n` +
    `            except SyntaxError as _e2:\n` +
    `                _diag.append({"sl":_e2.lineno or 1,"sc":_e2.offset or 1,"el":_e2.lineno or 1,"ec":getattr(_e2,"end_offset",None) or (_e2.offset or 1)+1,"msg":_e2.msg or "SyntaxError","sev":"error"})\n` +
    `except ImportError:\n` +
    `    try:\n` +
    `        _ast.parse(_src, filename="<editor>")\n` +
    `    except SyntaxError as _e:\n` +
    `        _diag.append({"sl":_e.lineno or 1,"sc":_e.offset or 1,"el":_e.lineno or 1,\n` +
    `            "ec":getattr(_e,"end_offset",None) or (_e.offset or 1)+1,"msg":_e.msg or "SyntaxError","sev":"error"})\n` +
    `except Exception as _ex:\n` +
    `    _diag.append({"sl":1,"sc":1,"el":1,"ec":2,"msg":"[PDV internal] " + repr(_ex),"sev":"warning"})\n` +
    `    try:\n` +
    `        _ast.parse(_src, filename="<editor>")\n` +
    `    except SyntaxError as _e:\n` +
    `        _diag.append({"sl":_e.lineno or 1,"sc":_e.offset or 1,"el":_e.lineno or 1,\n` +
    `            "ec":getattr(_e,"end_offset",None) or (_e.offset or 1)+1,"msg":_e.msg or "SyntaxError","sev":"error"})\n` +
    `print(_json.dumps(_diag))\n`
  );
}

/** Raw JSON shape returned by buildDiagCode. */
interface RawDiag { sl: number; sc: number; el: number; ec: number; msg: string; sev: string; }

/**
 * Try to extract a 1-based line number from a kernel error string.
 * ipykernel includes line info in SyntaxError evalue: "msg (line N)"
 * and in tracebacks: '  File "<ipython-input-...>", line N'.
 */
/**
 * Extract the most relevant line number from a kernel error.
 * Checks the traceback array first (most precise), then falls back to
 * string patterns in the error message itself.
 */
function extractErrorLine(errorStr: string, traceback?: string[]): number | null {
  if (traceback) {
    // Walk backwards — the last user-code frame is the most relevant.
    // IPython 7+ format:  Cell In[N], line N
    // IPython <7 format:  File "<ipython-input-N-xxx>", line N
    for (let i = traceback.length - 1; i >= 0; i--) {
      let m = /Cell\s+In\s*\[\d+\],\s+line\s+(\d+)/.exec(traceback[i]);
      if (m) return parseInt(m[1], 10);
      m = /File\s+"<ipython-input[^"]*>",\s+line\s+(\d+)/.exec(traceback[i]);
      if (m) return parseInt(m[1], 10);
    }
  }
  // SyntaxError: invalid syntax (line 5)
  let m = /\(line\s+(\d+)\)/.exec(errorStr);
  if (m) return parseInt(m[1], 10);
  return null;
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('tree');
  const [commandTabs, setCommandTabs] = useState<CommandTab[]>([{ id: 1, code: '' }]);
  const [activeCommandTab, setActiveCommandTab] = useState(1);
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
  const loadedProjectTabsRef = useRef<{ tabs: CommandTab[]; activeTabId: number } | null>(null);
  const [leftWidth, setLeftWidth] = useState(340);
  const [consoleHeight, setConsoleHeight] = useState(260);
  const dragRef = useRef<'vertical' | 'horizontal' | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const [autoRefreshNamespace, setAutoRefreshNamespace] = useState(false);
  const [namespaceRefreshToken, setNamespaceRefreshToken] = useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [createScriptTarget, setCreateScriptTarget] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Per-tab diagnostic markers derived from debounced kernel-side syntax checking. */
  const [commandTabMarkers, setCommandTabMarkers] = useState<Record<number, DiagnosticMarker[]>>({});
  /** Per-tab execution-error markers (set after a failed run, cleared on next code change). */
  const [execErrorMarkers, setExecErrorMarkers] = useState<Record<number, DiagnosticMarker[]>>({});
  /** Incremented on each code change to discard stale diagnostic results. */
  const diagGenerationRef = useRef(0);

  // Load command boxes from filesystem on startup
  useEffect(() => {
    if (!window.pdv?.commandBoxes) {
      return;
    }
    const loadCommandBoxes = async () => {
      try {
        const data = await window.pdv.commandBoxes.load();
        if (data) {
          setCommandTabs(data.tabs);
          setActiveCommandTab(data.activeTabId);
          console.log('[App] Loaded command boxes from filesystem:', data.tabs.length, 'tabs');
        }
      } catch (error) {
        console.error('[App] Failed to load command boxes:', error);
      }
    };
    void loadCommandBoxes();
  }, []);

  // Debounced save to filesystem
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!window.pdv?.commandBoxes) {
      return;
    }
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    // Debounce saves by 500ms to avoid excessive file writes
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await window.pdv.commandBoxes.save({
          tabs: commandTabs,
          activeTabId: activeCommandTab,
        });
        console.log('[App] Saved command boxes to filesystem');
      } catch (error) {
        console.error('[App] Failed to save command boxes:', error);
      }
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        // Save immediately on cleanup to avoid data loss
        void window.pdv.commandBoxes.save({
          tabs: commandTabs,
          activeTabId: activeCommandTab,
        });
      }
    };
  }, [commandTabs, activeCommandTab]);

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
        setConfig(loaded);
        setCurrentProjectDir(loaded.projectRoot ?? null);
        applyAppearanceColors(loaded.settings?.appearance?.colors);

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
    const onKeyDown = (event: KeyboardEvent) => {
      const openSettingsShortcut = config?.settings?.shortcuts?.openSettings ?? DEFAULT_OPEN_SETTINGS_SHORTCUT;
      if (matchesShortcut(event, openSettingsShortcut)) {
        event.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [config]);

  useEffect(() => {
    if (!window.pdv?.menu) {
      return;
    }
    const recentProjects = normalizeRecentProjects(config?.recentProjects);
    void window.pdv.menu.updateRecentProjects(recentProjects);
  }, [config]);

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
        setCommandTabs(loaded.tabs);
        setActiveCommandTab(loaded.activeTabId);
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
      } else if (dragRef.current === 'horizontal') {
        const bounds = rightPaneRef.current?.getBoundingClientRect();
        if (!bounds) return;
        const relativeY = event.clientY - bounds.top;
        const min = 140;
        const max = Math.max(min, bounds.height - 180);
        const next = Math.min(Math.max(relativeY, min), max);
        setConsoleHeight(next);
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

  // ---------------------------------------------------------------------------
  // Debounced real-time syntax diagnostics via the kernel
  // ---------------------------------------------------------------------------
  // Runs ast.parse on the active tab's code via a silent execute_request
  // (1.2 s after the user stops typing). ipykernel's ast.parse gives precise
  // line/column info for SyntaxErrors. Skipped while executing or no kernel.
  useEffect(() => {
    // Skip if no kernel is ready or if user code is already running
    if (!currentKernelId || kernelStatus !== 'ready' || isExecuting) return;

    const tabId = activeCommandTab;
    const code = commandTabs.find((t) => t.id === tabId)?.code ?? '';

    if (!code.trim()) {
      setCommandTabMarkers((prev) => ({ ...prev, [tabId]: [] }));
      return;
    }

    const gen = ++diagGenerationRef.current;

    const timer = setTimeout(async () => {
      try {
        const b64 = toBase64(code);
        const diagCode = buildDiagCode(b64);
        const result = await window.pdv.kernels.execute(currentKernelId, {
          code: diagCode,
          silent: true,
        });

        // Discard if a newer code version has arrived since we fired.
        if (diagGenerationRef.current !== gen) return;

        console.debug('[PDV diag] stdout:', result.stdout?.trim(), 'error:', result.error);
        const markers: DiagnosticMarker[] = [];
        if (result.stdout) {
          try {
            const raw = JSON.parse(result.stdout.trim()) as RawDiag[];
            for (const d of raw) {
              markers.push({
                startLineNumber: d.sl,
                startColumn: d.sc,
                endLineNumber: d.el,
                endColumn: d.ec,
                message: d.msg,
                severity: d.sev === 'warning' ? 'warning' : 'error',
              });
            }
          } catch { /* malformed JSON — ignore */ }
        }
        console.debug('[PDV diag] setting', markers.length, 'markers');
        setCommandTabMarkers((prev) => ({ ...prev, [tabId]: markers }));
      } catch (e) { console.debug('[PDV diag] execute threw:', e); }
    }, 1200);

    return () => clearTimeout(timer);
  }, [commandTabs, activeCommandTab, currentKernelId, kernelStatus, isExecuting]);

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

  const addCommandTab = () => {
    const newId = Math.max(0, ...commandTabs.map((t) => t.id)) + 1;
    setCommandTabs([...commandTabs, { id: newId, code: '' }]);
    setActiveCommandTab(newId);
  };

  const handleTabChange = (id: number) => {
    setActiveCommandTab(id);
    setLastError(undefined);
  };

  const handleCodeChange = (id: number, code: string) => {
    setCommandTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, code } : tab)));
    // Clear stale execution-error markers when the user edits the code.
    setExecErrorMarkers((prev) => {
      if (!prev[id]?.length) return prev;
      return { ...prev, [id]: [] };
    });
  };

  const handleClearConsole = () => {
    setLogs([]);
    setLastDuration(null);
  };

  const handleClearCommand = () => {
    setCommandTabs((prev) =>
      prev.map((tab) => (tab.id === activeCommandTab ? { ...tab, code: '' } : tab)),
    );
    setLastError(undefined);
  };

  const handleRemoveCommandTab = (id: number) => {
    setCommandTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fallback = { id: 1, code: '' };
        setActiveCommandTab(fallback.id);
        return [fallback];
      }
      const newActive = next.find((t) => t.id === activeCommandTab) || next[0];
      setActiveCommandTab(newActive.id);
      return next;
    });
    setLastError(undefined);
  };

  const handleSettingsSave = async (updates: Partial<Config>) => {
    if (updates.settings?.appearance?.colors) {
      applyAppearanceColors(updates.settings.appearance.colors);
    }
    await window.pdv.config.set(updates);
    const mergedConfig = config ? { ...config, ...updates } : null;
    setConfig(mergedConfig);
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

    // Clear execution-error markers for this tab; pyflakes markers stay.
    setExecErrorMarkers((prev) => ({ ...prev, [activeCommandTab]: [] }));

    setIsExecuting(true);
    setLastError(undefined);

    const logEntry: LogEntry = {
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      code,
    };

    try {
      const result = await window.pdv.kernels.execute(currentKernelId, { code });

      logEntry.stdout = result.stdout;
      logEntry.stderr = result.stderr;
      logEntry.result = result.result;
      logEntry.error = result.error;
      logEntry.duration = result.duration;
      logEntry.images = result.images;

      if (result.error) {
        setLastError(result.error);
        const errorLine = extractErrorLine(result.error, result.traceback);
        if (errorLine !== null) {
          setExecErrorMarkers((prev) => ({
            ...prev,
            [activeCommandTab]: [{
              startLineNumber: errorLine,
              startColumn: 1,
              endLineNumber: errorLine,
              endColumn: Number.MAX_SAFE_INTEGER,
              message: result.error!,
              severity: 'error',
            }],
          }));
        }
      } else {
        // Successful execution — clear execution-error markers.
        setExecErrorMarkers((prev) => ({ ...prev, [activeCommandTab]: [] }));
      }
    } catch (error) {
      logEntry.error = error instanceof Error ? error.message : String(error);
      setLastError(logEntry.error);
    } finally {
      setLogs((prev) => [...prev, logEntry]);
      if (typeof logEntry.duration === 'number') {
        setLastDuration(logEntry.duration);
      }
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
        tabs: commandTabs,
        activeTabId: activeCommandTab,
      });
      setCurrentProjectDir(saveDir);
      await rememberRecentProject(saveDir);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [activeCommandTab, commandTabs, currentProjectDir, kernelStatus, rememberRecentProject]);

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
      const normalized = normalizeLoadedCommandBoxes(loaded);
      loadedProjectTabsRef.current = normalized;
      setCommandTabs(normalized.tabs);
      setActiveCommandTab(normalized.activeTabId);
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
      {/* Header */}
      <header className="app-header">
        <h1 className="app-title">Physics Data Viewer</h1>
         <div className="header-right">
            <button className="btn btn-secondary" onClick={() => setShowSettings(true)}>Settings</button>
            <span className={`connection-status ${kernelStatus === 'ready' ? 'connected' : ''}`}>
              ● {kernelStatus === 'ready' ? 'Connected' : kernelStatus === 'starting' ? 'Starting...' : 'Disconnected'}
            </span>
          </div>
        </header>

      {/* Main content */}
      <main className="app-main">
        {/* Left pane:  Tree */}
        <aside className="left-pane" style={{ width: `${leftWidth}px` }}>
          <div className="pane-tabs">
            <button
              className={`tab ${activeTab === 'namespace' ? 'active' : ''}`}
              onClick={() => setActiveTab('namespace')}
            >
              Namespace
            </button>
            <button
              className={`tab ${activeTab === 'tree' ? 'active' : ''}`}
              onClick={() => setActiveTab('tree')}
            >
              Tree
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
              />
            </div>
            <div className={`tree-panel ${activeTab === 'modules' ? 'active' : ''}`}>
              <div className="tree-empty">Modules view (coming soon)</div>
            </div>
          </div>
        </aside>

        {/* Vertical resizer */}
        <div className="vertical-resizer" onMouseDown={startVerticalDrag} />

        {/* Right pane: Console + Command Box */}
        <div className="right-pane" ref={rightPaneRef}>
          <div className="console-wrapper" style={{ height: `${consoleHeight}px` }}>
            <Console logs={logs} onClear={handleClearConsole} />
          </div>

          {/* Horizontal resizer */}
          <div className="horizontal-resizer" onMouseDown={startHorizontalDrag} />

          <CommandBox
            tabs={commandTabs.map((tab) => ({
              ...tab,
              onChange: (code: string) => handleCodeChange(tab.id, code),
            }))}
            activeTabId={activeCommandTab}
            kernelId={currentKernelId}
            markers={[...(commandTabMarkers[activeCommandTab] ?? []), ...(execErrorMarkers[activeCommandTab] ?? [])]}
            disabled={kernelStatus !== 'ready'}
            onTabChange={handleTabChange}
            onAddTab={addCommandTab}
            onRemoveTab={handleRemoveCommandTab}
            onExecute={handleExecute}
            onClear={handleClearCommand}
            isExecuting={isExecuting}
            lastError={lastError}
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
             onClick={() => setShowEnvSelector(true)}
             title="Click to change kernel"
           >
             {config?.kernelSpec ?? 'python3'}
           </span>
           <span className="status-item">~/projects</span>
         </div>
         <div className="status-right">
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
         config={config}
         onClose={() => setShowSettings(false)}
         onSave={handleSettingsSave}
       />
     </div>
   );
 };

export default App;
