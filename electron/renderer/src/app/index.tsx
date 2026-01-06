import React, { useEffect, useState, useRef, useCallback } from 'react';
import { CommandBox } from '../components/CommandBox';
import { Console } from '../components/Console';
import { Tree } from '../components/Tree';
import { EnvironmentSelector } from '../components/EnvironmentSelector';
import { NamespaceView } from '../components/NamespaceView';
import { ScriptDialog } from '../components/ScriptDialog';
import { CreateScriptDialog } from '../components/Tree/CreateScriptDialog';
import type { CommandTab, LogEntry, TreeNodeData } from '../types';
import type { Config } from '../../main/ipc';

type Tab = 'tree' | 'namespace' | 'modules';
type PlotMode = 'native' | 'capture';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('tree');
  const [plotMode, setPlotMode] = useState<PlotMode>('native');
  const [commandTabs, setCommandTabs] = useState<CommandTab[]>([{ id: 1, code: '' }]);
  const [activeCommandTab, setActiveCommandTab] = useState(1);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentKernelId, setCurrentKernelId] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [showEnvSelector, setShowEnvSelector] = useState(false);
  const [scriptDialog, setScriptDialog] = useState<{ scriptPath: string; scriptName: string } | null>(null);
  const initRef = useRef(false);
  const [leftWidth, setLeftWidth] = useState(340);
  const [consoleHeight, setConsoleHeight] = useState(260);
  const dragRef = useRef<'vertical' | 'horizontal' | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const [autoRefreshNamespace, setAutoRefreshNamespace] = useState(false);
  const [namespaceRefreshToken, setNamespaceRefreshToken] = useState(0);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [createScriptTarget, setCreateScriptTarget] = useState<string | null>(null);

  useEffect(() => {
    // Prevent double initialization in StrictMode
    if (initRef.current) return;
    initRef.current = true;

    const initConfig = async () => {
      try {
        const loaded = await window.pdv.config.get();
        setConfig(loaded);
        setPlotMode(loaded.plotMode ?? 'native');

        if (!loaded.pythonPath || !loaded.juliaPath) {
          setShowEnvSelector(true);
          return;
        }

        await startKernel(loaded);
      } catch (error) {
        console.error('[App] Failed to load config:', error);
      }
    };

    void initConfig();
  }, []);

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

  const startVerticalDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = 'vertical';
  }, []);

  const startHorizontalDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = 'horizontal';
  }, []);

  const startKernel = async (cfg: Config) => {
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
      console.log('[App] Kernel started successfully:', kernel);
    } catch (error) {
      console.error('[App] Failed to start kernel:', error);
      // Show error to user
      setLastError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleEnvSave = async (paths: { pythonPath: string; juliaPath: string }) => {
    const updatedConfig: Config = {
      kernelSpec: config?.kernelSpec ?? null,
      plotMode: config?.plotMode ?? 'native',
      cwd: config?.cwd ?? '',
      trusted: config?.trusted ?? false,
      recentProjects: config?.recentProjects ?? [],
      customKernels: config?.customKernels ?? [],
      pythonPath: paths.pythonPath,
      juliaPath: paths.juliaPath,
    };

    await window.pdv.config.set(updatedConfig);
    setConfig(updatedConfig);
    setShowEnvSelector(false);
    await startKernel(updatedConfig);
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

  const handlePlotModeChange = async (mode: PlotMode) => {
    setPlotMode(mode);
    if (config) {
      const next = { ...config, plotMode: mode };
      setConfig(next);
      await window.pdv.config.set({ plotMode: mode });
      await startKernel(next);
    }
  };

  const handleTreeAction = async (action: string, node: TreeNodeData) => {
    console.log('[App] Tree action:', action, node);

    if (action === 'create_script') {
      setCreateScriptTarget(node.path);
    } else if (action === 'run' && node.type === 'script') {
      setScriptDialog({
        scriptPath: node.path,
        scriptName: node.key,
      });
    } else if (action === 'edit' && node.type === 'script') {
      try {
        await window.pdv.script.edit(node.path);
      } catch (error) {
        console.error('[App] Failed to open editor:', error);
      }
    } else if (action === 'reload' && node.type === 'script') {
      await window.pdv.script.reload(node.path);
    } else if (action === 'copy_path') {
      // Format path to be python dictionary style and add "tree" to beginning (e.g., tree["data"]["array1"])
      await navigator.clipboard.writeText(node.path.split('.').reduce((acc, part) => `${acc}["${part}"]`, 'tree'));
    } else if (action === 'print') {
      if (!currentKernelId) return;
      const target = JSON.stringify(node.path);
      await handleExecute(`print(tree[${target}])`);
    }
  };

  const handleScriptRun = async (params: Record<string, unknown>) => {
    if (!scriptDialog || !currentKernelId) return;

    setScriptDialog(null);

    try {
      const logEntry: LogEntry = {
        id:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        code: `tree.run_script("${scriptDialog.scriptPath}", **params)`,
      };

      const result = await window.pdv.script.run(currentKernelId, {
        scriptPath: scriptDialog.scriptPath,
        params,
      });

      if (!result.success) {
        setLastError(result.error);
        logEntry.error = result.error;
      } else {
        logEntry.result = result.result;
        logEntry.duration = result.duration;
      }
      setLogs((prev) => [...prev, logEntry]);
      setNamespaceRefreshToken((prev) => prev + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      console.error('[App] Script execution error:', error);
    }
  };

  const handleExecute = async (code: string) => {
    if (!currentKernelId || !code.trim()) return;

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
      const result = await window.pdv.kernels.execute(currentKernelId, {
        code,
        capture: plotMode === 'capture',
      });

      logEntry.stdout = result.stdout;
      logEntry.stderr = result.stderr;
      logEntry.result = result.result;
      logEntry.error = result.error;
      logEntry.duration = result.duration;
      logEntry.images = result.images;

      if (result.error) {
        setLastError(result.error);
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
      setTreeRefreshToken((prev) => prev + 1);
    }
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <h1 className="app-title">Physics Data Viewer</h1>
         <div className="header-right">
           <span className="connection-status connected">● Connected</span>
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
                autoRefresh={autoRefreshNamespace}
                refreshToken={namespaceRefreshToken}
                refreshInterval={2000}
                onToggleAutoRefresh={setAutoRefreshNamespace}
              />
            </div>
            <div className={`tree-panel ${activeTab === 'tree' ? 'active' : ''}`}>
              <Tree kernelId={currentKernelId} refreshToken={treeRefreshToken} onAction={handleTreeAction} />
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
            onTabChange={handleTabChange}
            onAddTab={addCommandTab}
            onExecute={handleExecute}
            onClear={handleClearCommand}
            isExecuting={isExecuting}
            lastError={lastError}
          />
        </div>
      </main>

      {scriptDialog && (
        <ScriptDialog
          scriptPath={scriptDialog.scriptPath}
          scriptName={scriptDialog.scriptName}
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
              } else {
                setTreeRefreshToken((prev) => prev + 1);
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
           <span className="status-item">{config?.kernelSpec ?? 'python3'}</span>
           <span className="status-item">~/projects</span>
         </div>
         <div className="status-right">
           <span className="status-item plot-toggle">
             <span>Plot: </span>
             <button
               className={`toggle ${plotMode === 'native' ? 'active' : ''}`}
               onClick={() => handlePlotModeChange('native')}
             >
               Native
             </button>
             <button
               className={`toggle ${plotMode === 'capture' ? 'active' : ''}`}
               onClick={() => handlePlotModeChange('capture')}
             >
               Capture
             </button>
           </span>
           <span className="status-item">
             Last: {lastDuration !== null ? `${Math.round(lastDuration)}ms` : '--'}
           </span>
         </div>
       </footer>

       {showEnvSelector && (
         <EnvironmentSelector
           isFirstRun={!config?.pythonPath || !config?.juliaPath}
           currentConfig={config || undefined}
           onSave={handleEnvSave}
           onCancel={() => setShowEnvSelector(false)}
         />
       )}
     </div>
   );
 };

export default App;
