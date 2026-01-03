import React, { useState, useEffect } from 'react';
import { PythonEditor } from './components/CommandInput/PythonEditor';
import { BackendClient, ExecuteResult } from './api/client';
import { TreeView, TreeNodeData } from './components/DataViewer/TreeView';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { ResultWindow, DisplayResult } from './components/ResultDisplay/ResultWindow';
import { MethodIntrospector, normalizeInvokeResult, pickDefaultMethod } from './utils/methodIntrospection';
import { backendPath } from './utils/dataFormatting';
import './App.css';

interface CommandBox {
  id: number;
  code: string;
}

type ViewerTab = 'namespace' | 'tree';

interface AppProps {
  client?: BackendClient;
}

export const App: React.FC<AppProps> = ({ client: providedClient }) => {
  const [client] = useState(() => providedClient ?? new BackendClient('http://localhost:8000'));
  const [isConnected, setIsConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [commandBoxes, setCommandBoxes] = useState<CommandBox[]>([{ id: 1, code: '' }]);
  const [activeBoxId, setActiveBoxId] = useState(1);
  const [nextId, setNextId] = useState(2);
  const [viewerData, setViewerData] = useState<Record<string, any>>({});
  const [treeData] = useState<Record<string, any>>({});
  const [results, setResults] = useState<DisplayResult[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    node: TreeNodeData;
    methods: { name: string; requires_arguments: boolean }[];
  } | null>(null);
  const [viewerTab, setViewerTab] = useState<ViewerTab>('namespace');
  const [introspector] = useState(() => new MethodIntrospector(client));

  useEffect(() => {
    // Connect to backend on mount
    client
      .connect()
      .then((sid) => {
        setSessionId(sid);
        setIsConnected(true);
        return client.getState(sid).catch(() => ({}));
      })
      .then((state) => setViewerData(state || {}))
      .catch((err) => {
        setError(`Failed to connect to backend: ${err.message}`);
        console.error('Connection error:', err);
      });
  }, [client]);

  const handleExecute = async () => {
    if (!isConnected) {
      setError('Not connected to backend');
      return;
    }

    const activeBox = commandBoxes.find(box => box.id === activeBoxId);
    if (!activeBox || !activeBox.code.trim()) {
      return;
    }

    try {
      const result: ExecuteResult = await client.execute(activeBox.code);
      setSessionId(result.session_id);
      setViewerData(result.state || {});

      // Add to output log
      const newOutput = [
        `>>> ${activeBox.code}`,
        ...(result.stdout ? [result.stdout] : []),
        ...(result.stderr ? [result.stderr] : []),
        ...(result.error ? [`Error: ${result.error}`] : []),
      ];
      
      setOutput((prev) => [...prev, ...newOutput]);
      setError(null);
    } catch (err: any) {
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
      setViewerData(state || {});
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
      setResults((prev) => [...prev, display]);
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
    setResults((prev) => [...prev, display]);
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
        <div className="top-grid">
          <div className="output-panel">
            <h2>Output</h2>
            <div className="output-content">
              {output.length === 0 ? (
                <div className="empty-state">No output yet. Execute some Python code below.</div>
              ) : (
                output.map((line, index) => (
                  <div key={index} className="output-line">
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>

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
              </div>
              <div className="data-actions">
                <button className="action-button" onClick={handleRefreshState} disabled={!sessionId}>
                  Refresh
                </button>
              </div>
            </div>
            <TreeView
              data={viewerTab === 'namespace' ? viewerData : treeData}
              viewportHeight={260}
              onNodeDoubleClick={handleNodeDoubleClick}
              onContextMenu={handleContextMenu}
            />
            {viewerTab === 'tree' && (
              <div className="data-panel-note">
                Central project Tree placeholder — future PRs will populate this nested structure.
              </div>
            )}
            <ResultWindow results={results} onClear={() => setResults([])} />
          </div>
        </div>

        <div className="command-panel">
          <div className="command-panel-header">
            <h2>Command Input</h2>
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
          </div>
          {error && (
            <div className="error-message">
              {error}
            </div>
          )}
          <PythonEditor
            key={activeBoxId}
            value={activeBox?.code || ''}
            onCodeChange={handleCodeChange}
            onExecute={handleExecute}
            client={client}
            height="200px"
          />
          <div className="command-actions">
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
