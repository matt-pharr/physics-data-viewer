import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PythonEditor } from './components/CommandInput/PythonEditor';
import { BackendClient, ExecuteResult, ModulePanel } from './api/client';
import { TreeView, TreeNodeData } from './components/DataViewer/TreeView';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { MethodIntrospector, normalizeInvokeResult, pickDefaultMethod } from './utils/methodIntrospection';
import { backendPath } from './utils/dataFormatting';
import { LogViewer } from './components/CommandLog/LogViewer';
import { LogSearch } from './components/CommandLog/LogSearch';
import { LogEntry, buildLogExport } from './utils/logFormatting';
import { ModulePanelCard } from './components/ModulePanel/ModulePanel';
import './App.css';

interface CommandBox {
  id: number;
  code: string;
}

const COMMAND_BOX_STORAGE_PREFIX = 'pdv-command-boxes-';

type ViewerTab = 'namespace' | 'tree' | 'modules';

interface AppProps {
  client?: BackendClient;
}

export const App: React.FC<AppProps> = ({ client: providedClient }) => {
  const [client] = useState(() => providedClient ?? new BackendClient('http://localhost:8000'));
  const [isConnected, setIsConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandBoxes, setCommandBoxes] = useState<CommandBox[]>([{ id: 1, code: '' }]);
  const [activeBoxId, setActiveBoxId] = useState(1);
  const [nextId, setNextId] = useState(2);
  const [viewerData, setViewerData] = useState<Record<string, any>>({});
  const [treeData, setTreeData] = useState<Record<string, any>>({});
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logQuery, setLogQuery] = useState('');
  const [modulePanels, setModulePanels] = useState<ModulePanel[]>([]);
  const [modulePanelsLoading, setModulePanelsLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    node: TreeNodeData;
    methods: { name: string; requires_arguments: boolean }[];
  } | null>(null);
  const [viewerTab, setViewerTab] = useState<ViewerTab>('tree');
  const [introspector] = useState(() => new MethodIntrospector(client));
  const [columnRatio, setColumnRatio] = useState(0.55);
  const [rightSplitRatio, setRightSplitRatio] = useState(0.55);
  const logIdRef = useRef(1);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const dragModeRef = useRef<'vertical' | 'horizontal' | null>(null);

  useEffect(() => {
    // Connect to backend on mount
    const storedSession = window.localStorage.getItem('pdv-session-id') || undefined;
    client
      .connect(storedSession)
      .then((sid) => {
        setSessionId(sid);
        window.localStorage.setItem('pdv-session-id', sid);
        setIsConnected(true);
        return client.getState(sid).catch(() => ({}));
      })
      .then(async (state) => {
        const resolved = state || {};
        setViewerData(resolved);
        const tree = await client.getProjectTree().catch(() => ({}));
        setTreeData(tree);
        await loadModulePanels();
      })
      .catch((err) => {
        setError(`Failed to connect to backend: ${err.message}`);
        console.error('Connection error:', err);
      });
  }, [client]);

  // Load command boxes for the session from localStorage when available
  useEffect(() => {
    if (!sessionId) return;
    const stored = window.localStorage.getItem(`${COMMAND_BOX_STORAGE_PREFIX}${sessionId}`);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as { boxes?: CommandBox[]; activeId?: number; nextId?: number };
      if (parsed.boxes && parsed.boxes.length > 0) {
        setCommandBoxes(parsed.boxes);
        setActiveBoxId(parsed.activeId ?? parsed.boxes[0].id);
        setNextId(parsed.nextId ?? Math.max(...parsed.boxes.map((b) => b.id)) + 1);
      }
    } catch (err) {
      console.warn('Failed to parse stored command boxes', err);
    }
  }, [sessionId]);

  // Persist command boxes per session
  useEffect(() => {
    if (!sessionId) return;
    const payload = JSON.stringify({
      boxes: commandBoxes,
      activeId: activeBoxId,
      nextId,
    });
    window.localStorage.setItem(`${COMMAND_BOX_STORAGE_PREFIX}${sessionId}`, payload);
  }, [sessionId, commandBoxes, activeBoxId, nextId]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!layoutRef.current || !dragModeRef.current) {
        return;
      }
      if (dragModeRef.current === 'vertical') {
        const rect = layoutRef.current.getBoundingClientRect();
        const ratio = (event.clientX - rect.left) / rect.width;
        setColumnRatio(Math.min(0.8, Math.max(0.2, ratio)));
      } else if (dragModeRef.current === 'horizontal' && rightPaneRef.current) {
        const rect = rightPaneRef.current.getBoundingClientRect();
        const ratio = (event.clientY - rect.top) / rect.height;
        setRightSplitRatio(Math.min(0.85, Math.max(0.25, ratio)));
      }
    };

    const handleUp = () => {
      dragModeRef.current = null;
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const startDrag = (mode: 'vertical' | 'horizontal') => (event: React.MouseEvent) => {
    event.preventDefault();
    dragModeRef.current = mode;
  };

  const filteredLogEntries = useMemo(() => {
    if (!logQuery.trim()) {
      return logEntries;
    }
    const query = logQuery.toLowerCase();
    return logEntries.filter((entry) => {
      return [entry.code, entry.stdout, entry.stderr, entry.error]
        .filter(Boolean)
        .some((text) => (text as string).toLowerCase().includes(query));
    });
  }, [logEntries, logQuery]);

  const loadModulePanels = async () => {
    setModulePanelsLoading(true);
    try {
      const panels = await client.listModulePanels();
      setModulePanels(panels);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setModulePanelsLoading(false);
    }
  };

  const refreshModulePanel = async (panelId: string) => {
    try {
      const refreshed = await client.refreshModulePanel(panelId);
      setModulePanels((prev) => {
        const known = prev.some((panel) => panel.panel_id === panelId);
        if (!known) {
          throw new Error(`Panel not found: ${panelId}`);
        }
        return prev.map((panel) => (panel.panel_id === panelId ? refreshed : panel));
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const appendLogEntry = (payload: Omit<LogEntry, 'id'>) => {
    setLogEntries((prev) => [...prev, { ...payload, id: logIdRef.current++ }]);
  };

  const handleExecute = async () => {
    if (!isConnected) {
      setError('Not connected to backend');
      return;
    }

    const activeBox = commandBoxes.find(box => box.id === activeBoxId);
    if (!activeBox || !activeBox.code.trim()) {
      return;
    }

    const startedAt = Date.now();
    const startHr = performance.now();

    try {
      const result: ExecuteResult = await client.execute(activeBox.code);
      setSessionId(result.session_id);
      window.localStorage.setItem('pdv-session-id', result.session_id);
      const resolvedState = result.state || {};
      setViewerData(resolvedState);
      const tree = await client.getProjectTree().catch(() => ({}));
      setTreeData(tree);
      await loadModulePanels();

      appendLogEntry({
        code: activeBox.code,
        stdout: result.stdout || undefined,
        stderr: result.stderr || undefined,
        error: result.error || undefined,
        timestamp: startedAt,
        durationMs: performance.now() - startHr,
      });
      setError(null);
    } catch (err: any) {
      appendLogEntry({
        code: activeBox.code,
        error: err.message,
        timestamp: startedAt,
        durationMs: performance.now() - startHr,
      });
      setError(`Execution failed: ${err.message}`);
      console.error('Execution error:', err);
    }
  };

  const handleRefreshState = async () => {
    if (!sessionId) {
      return;
    }
    try {
      const state = await client.getState(sessionId);
      const resolved = state || {};
      setViewerData(resolved);
      const tree = await client.getProjectTree().catch(() => ({}));
      setTreeData(tree);
      await loadModulePanels();
    } catch (err: any) {
      setError(`Failed to refresh state: ${err.message}`);
    }
  };

  const handleNodeDoubleClick = async (node: TreeNodeData) => {
    if (!sessionId) {
      setError('Not connected to backend');
      return;
    }
    try {
      const methods = await introspector.getMethods(sessionId, backendPath(node.path));
      const target = pickDefaultMethod(methods);
      if (!target) {
        setError('No invokable methods for this item.');
        return;
      }
      const result = await client.invokeMethod(sessionId, backendPath(node.path), target.name);
      const display = normalizeInvokeResult(result);
      appendLogEntry({
        code: `[invoke] ${backendPath(node.path).join('.')} :: ${target.name}`,
        stdout: display.content ? JSON.stringify(display.content, null, 2) : undefined,
        error: display.error ?? undefined,
        timestamp: Date.now(),
        durationMs: 0,
      });
      setError(display.error ?? null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleContextMenu = async (node: TreeNodeData, position: { x: number; y: number }) => {
    if (!sessionId) {
      setError('Not connected to backend');
      return;
    }
    try {
      const methods = await introspector.getMethods(sessionId, backendPath(node.path));
      setContextMenu({ node, position, methods });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const invokeMethod = async (methodName: string, node: TreeNodeData) => {
    if (!sessionId) {
      return;
    }
    const result = await client.invokeMethod(sessionId, backendPath(node.path), methodName);
    const display = normalizeInvokeResult(result);
    appendLogEntry({
      code: `[invoke] ${backendPath(node.path).join('.')} :: ${methodName}`,
      stdout: display.content ? JSON.stringify(display.content, null, 2) : undefined,
      error: display.error ?? undefined,
      timestamp: Date.now(),
      durationMs: 0,
    });
    setError(display.error ?? null);
  };

  const handleCodeChange = (code: string) => {
    setCommandBoxes(boxes =>
      boxes.map(box => 
        box.id === activeBoxId ? { ...box, code } : box
      )
    );
  };

  const handleClearOrClose = () => {
    const activeBox = commandBoxes.find(box => box.id === activeBoxId);
    
    // If the active box is empty, close it (unless it's the last tab)
    if (activeBox && !activeBox.code.trim() && commandBoxes.length > 1) {
      const newBoxes = commandBoxes.filter(box => box.id !== activeBoxId);
      setCommandBoxes(newBoxes);
      // Switch to the first remaining tab
      setActiveBoxId(newBoxes[0].id);
    } else {
      // Otherwise, just clear the code
      setCommandBoxes(boxes =>
        boxes.map(box =>
          box.id === activeBoxId ? { ...box, code: '' } : box
        )
      );
    }
  };

  const handleAddCommandBox = () => {
    const newBox: CommandBox = { id: nextId, code: '' };
    setCommandBoxes([...commandBoxes, newBox]);
    setActiveBoxId(nextId);
    setNextId(nextId + 1);
  };

  const handleClearLog = () => setLogEntries([]);

  const handleExportLog = () => {
    if (logEntries.length === 0) {
      return;
    }
    const blob = new Blob([buildLogExport(logEntries)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'command-log.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const activeBox = commandBoxes.find(box => box.id === activeBoxId);
  const isActiveBoxEmpty = !activeBox?.code.trim();

  return (
    <div className="app">
      <header className="app-header">
        <h1>Physics Data Viewer</h1>
        <div className="connection-status">
          {isConnected ? (
            <span className="connected">● Connected</span>
          ) : (
            <span className="disconnected">● Disconnected</span>
          )}
        </div>
      </header>

      <main className="app-main">
        <div className="split-layout" ref={layoutRef}>
          <div className="pane data-pane" style={{ width: `${columnRatio * 100}%` }}>
            <div className="data-panel">
              <div className="data-panel-header">
                <h2>Data Viewer</h2>
                <div className="data-tabs">
                  <button
                    className={`tab ${viewerTab === 'namespace' ? 'active' : ''}`}
                    onClick={() => setViewerTab('namespace')}
                  >
                    Namespace
                  </button>
                  <button
                    className={`tab ${viewerTab === 'tree' ? 'active' : ''}`}
                    onClick={() => setViewerTab('tree')}
                  >
                    Tree
                  </button>
                  <button
                    className={`tab ${viewerTab === 'modules' ? 'active' : ''}`}
                    onClick={() => setViewerTab('modules')}
                  >
                    Modules
                  </button>
                </div>
                <div className="data-actions">
                  <button className="action-button" onClick={handleRefreshState} disabled={!sessionId}>
                    Refresh
                  </button>
                </div>
              </div>
              {viewerTab === 'modules' ? (
                <div className="module-panels">
                  {modulePanelsLoading ? (
                    <div className="loading">Loading module panels…</div>
                  ) : modulePanels.length === 0 ? (
                    <div className="empty-state">No module panels registered by modules.</div>
                  ) : (
                    modulePanels.map((panel) => (
                      <ModulePanelCard key={panel.panel_id} panel={panel} onRefresh={refreshModulePanel} />
                    ))
                  )}
                </div>
              ) : (
                <TreeView
                  data={viewerTab === 'namespace' ? viewerData : treeData}
                  onNodeDoubleClick={handleNodeDoubleClick}
                  onContextMenu={handleContextMenu}
                />
              )}
            </div>
          </div>

          <div className="vertical-resizer" onMouseDown={startDrag('vertical')} />

          <div className="pane right-pane" ref={rightPaneRef} style={{ width: `${(1 - columnRatio) * 100}%` }}>
            <div className="right-top" style={{ height: `${rightSplitRatio * 100}%` }}>
              <div className="output-panel">
                <div className="panel-header">
                  <h2>Console</h2>
                </div>
                <LogSearch
                  query={logQuery}
                  total={logEntries.length}
                  filteredCount={filteredLogEntries.length}
                  onChange={setLogQuery}
                  onReset={() => setLogQuery('')}
                />
                <LogViewer entries={filteredLogEntries} onClear={handleClearLog} onExport={handleExportLog} />
              </div>
            </div>

            <div className="horizontal-resizer" onMouseDown={startDrag('horizontal')} />

            <div className="right-bottom">
              <div className="command-panel">
                <div className="command-panel-header">
                  <h2>Command Input</h2>
                  <div className="command-header-actions">
                    <div className="command-tabs">
                      {commandBoxes.map((box) => (
                        <button
                          key={box.id}
                          className={`tab ${box.id === activeBoxId ? 'active' : ''}`}
                          onClick={() => setActiveBoxId(box.id)}
                        >
                          {box.id}
                        </button>
                      ))}
                      <button className="tab add-tab" onClick={handleAddCommandBox} title="Add new command box">
                        +
                      </button>
                    </div>
                    <div className="command-actions-top">
                      <button className="action-button execute" onClick={handleExecute}>
                        Execute
                      </button>
                      <button
                        className={`action-button ${isActiveBoxEmpty ? 'close' : 'clear'}`}
                        onClick={handleClearOrClose}
                      >
                        {isActiveBoxEmpty && commandBoxes.length > 1 ? 'Close' : 'Clear'}
                      </button>
                    </div>
                  </div>
                </div>
                {error && <div className="error-message">{error}</div>}
                <div className="command-panel-content">
                  <PythonEditor
                    key={activeBoxId}
                    value={activeBox?.code || ''}
                    onCodeChange={handleCodeChange}
                    onExecute={handleExecute}
                    client={client}
                    height="100%"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        {contextMenu && (
          <ContextMenu
            position={contextMenu.position}
            items={contextMenu.methods.map((method) => ({
              label: method.name,
              enabled: !method.requires_arguments,
              onSelect: () => invokeMethod(method.name, contextMenu.node),
            }))}
            onClose={() => setContextMenu(null)}
          />
        )}
      </main>
    </div>
  );
};
