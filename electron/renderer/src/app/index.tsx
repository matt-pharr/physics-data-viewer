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
import type {
  CellTab,
  Config,
  KernelExecuteResult,
  KernelExecutionOrigin,
  LogEntry,
  TreeNodeData,
} from '../types';
import { resolveShortcuts } from '../shortcuts';
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
  const {
    leftSidebarOpen,
    leftPanel,
    rightSidebarOpen,
    rightPanel,
    editorCollapsed,
    leftWidth,
    rightWidth,
    editorHeight,
    rightPaneRef,
    startVerticalDrag,
    startHorizontalDrag,
    startRightDrag,
    handleActivityBarClick,
    toggleLeftSidebar,
    toggleEditorCollapsed,
    collapseLeftSidebar,
    collapseRightSidebar,
    expandEditor,
  } = useLayoutState();

  // -- Editor state ----------------------------------------------------------
  const [CellTabs, setCellTabs] = useState<CellTab[]>([{ id: 1, code: '' }]);
  const [activeCellTab, setActiveCellTab] = useState(1);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // -- Kernel state ---------------------------------------------------------
  const [currentKernelId, setCurrentKernelId] = useState<string | null>(null);
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>('idle');
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [codeCellExecutionError, setCodeCellExecutionError] =
    useState<CodeCellExecutionError | undefined>(undefined);
  const [lastDuration, setLastDuration] = useState<number | null>(null);

  // -- App / config state ---------------------------------------------------
  const [config, setConfig] = useState<Config | null>(null);
  const [currentProjectDir, setCurrentProjectDir] = useState<string | null>(null);
  const initRef = useRef(false);
  const loadedProjectTabsRef = useRef<{ tabs: CellTab[]; activeTabId: number } | null>(null);

  // Undo stack for cell clear/close. Each entry captures the full tab list and
  // active tab id so a single Cmd+Z restores exactly what was destroyed.
  type CellSnapshot = { tabs: CellTab[]; activeTabId: number };
  const cellUndoStack = useRef<CellSnapshot[]>([]);

  // -- Refresh tokens (bumped by push subscriptions to trigger re-fetches) --
  const [autoRefreshNamespace, setAutoRefreshNamespace] = useState(false);
  const [namespaceRefreshToken, setNamespaceRefreshToken] = useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [modulesRefreshToken, setModulesRefreshToken] = useState(0);

  // -- Dialog visibility state ----------------------------------------------
  const [showEnvSelector, setShowEnvSelector] = useState(false);
  const [scriptDialog, setScriptDialog] = useState<TreeNodeData | null>(null);
  const [createScriptTarget, setCreateScriptTarget] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'shortcuts' | 'appearance' | 'runtime' | 'about'>('general');

  // -- Appearance state -----------------------------------------------------
  const monacoTheme = useThemeManager({ config });

  const shortcuts = useMemo(() => resolveShortcuts(config?.settings?.shortcuts), [config]);
  useCodeCellsPersistence({
    cellTabs: CellTabs,
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

  useEffect(() => {
    if (!window.pdv?.menu) {
      return;
    }
    const recentProjects = normalizeRecentProjects(config?.recentProjects);
    void window.pdv.menu.updateRecentProjects(recentProjects);
  }, [config]);

  useKernelSubscriptions({
    currentKernelId,
    loadedProjectTabsRef,
    setCellTabs,
    setActiveCellTab,
    setLogs,
    setTreeRefreshToken,
    setModulesRefreshToken,
  });

  const { startKernel, handleEnvSave, handleRestartKernel } = useKernelLifecycle({
    config,
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setShowEnvSelector,
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
      { tabs: CellTabs, activeTabId: activeCellTab },
    ].slice(-20); // keep at most 20 levels
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
    if (codeCellExecutionError?.tabId === id) {
      setCodeCellExecutionError(undefined);
    }
    setLastError(undefined);
  };

  useKeyboardShortcuts({
    shortcuts,
    cellTabs: CellTabs,
    activeCellTab,
    cellUndoStack,
    setCellTabs,
    setActiveCellTab,
    setShowSettings,
    setSettingsInitialTab,
    toggleLeftSidebar,
    toggleEditorCollapsed,
    addCellTab,
    removeCellTab: handleRemoveCellTab,
  });

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
      await handleExecute(`print(pdv_tree[${target}])`, {
        kind: 'unknown',
        label: `Tree print ${node.path}`,
      });
    }
  };

  const handleScriptRun = ({
    code,
    executionId,
    origin,
    result,
  }: {
    code: string;
    executionId: string;
    origin: KernelExecutionOrigin;
    result: KernelExecuteResult;
  }) => {
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
    setScriptDialog(null);
  };

  const handleExecute = async (code: string, originOverride?: KernelExecutionOrigin) => {
    if (!currentKernelId || kernelStatus !== 'ready' || !code.trim()) return;

    setIsExecuting(true);
    setLastError(undefined);
    setCodeCellExecutionError(undefined);

    const executionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const activeTab = CellTabs.find((tab) => tab.id === activeCellTab);
    const origin: KernelExecutionOrigin = originOverride ?? {
      kind: 'code-cell',
      label: activeTab?.name?.trim() ? activeTab.name : `Tab ${activeCellTab}`,
      tabId: activeCellTab,
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
    }
  };

  const {
    unsavedDialogContext,
    handleSaveProject,
    handleOpenProject,
    handleUnsavedSave,
    handleUnsavedDiscard,
    handleUnsavedCancel,
  } = useProjectWorkflow({
    kernelStatus,
    currentProjectDir,
    cellTabs: CellTabs,
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
  });

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
              onClick={expandEditor}
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
                  kernelId={currentKernelId}
                  disabled={kernelStatus !== 'ready'}
                  onTabChange={handleTabChange}
                  onAddTab={addCellTab}
                  onRemoveTab={handleRemoveCellTab}
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
                  onClick={collapseRightSidebar}
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
