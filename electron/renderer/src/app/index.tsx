import React, { useEffect, useState } from 'react';
import { CommandBox } from '../components/CommandBox';
import { Console } from '../components/Console';
import type { CommandTab, LogEntry } from '../types';

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

  useEffect(() => {
    const initKernel = async () => {
      try {
        const kernel = await window.pdv.kernels.start({ language: 'python' });
        setCurrentKernelId(kernel.id);
        console.log('[App] Kernel started:', kernel.id);
      } catch (error) {
        console.error('[App] Failed to start kernel:', error);
      }
    };

    void initKernel();
  }, []);

  const addCommandTab = () => {
    const newId = Math.max(...commandTabs.map((t) => t.id)) + 1;
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

  const handleExecute = async (code: string) => {
    if (!currentKernelId || !code.trim()) return;

    setIsExecuting(true);
    setLastError(undefined);

    const logEntry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
      }
    } catch (error) {
      logEntry.error = error instanceof Error ? error.message : String(error);
      setLastError(logEntry.error);
    } finally {
      setLogs((prev) => [logEntry, ...prev]);
      if (typeof logEntry.duration === 'number') {
        setLastDuration(logEntry.duration);
      }
      setIsExecuting(false);
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
        <aside className="left-pane">
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

          <div className="tree-container">
            <div className="tree-header">
              <span className="tree-col key">Key</span>
              <span className="tree-col type">Type</span>
              <span className="tree-col preview">Preview</span>
            </div>
            <div className="tree-content">
              {activeTab === 'tree' && (
                <div className="tree-empty">
                  <p>No data loaded</p>
                  <p className="hint">Tree view will appear here</p>
                </div>
              )}
              {activeTab === 'namespace' && (
                <div className="tree-empty">
                  <p>Namespace</p>
                  <p className="hint">Kernel variables will appear here</p>
                </div>
              )}
              {activeTab === 'modules' && (
                <div className="tree-empty">
                  <p>Modules</p>
                  <p className="hint">Loaded modules will appear here</p>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Vertical resizer */}
        <div className="vertical-resizer" />

        {/* Right pane: Console + Command Box */}
        <div className="right-pane">
          <Console logs={logs} onClear={handleClearConsole} />

          {/* Horizontal resizer */}
          <div className="horizontal-resizer" />

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

      {/* Status bar */}
      <footer className="status-bar">
        <div className="status-left">
          <span className="status-item">
            <span className={`status-dot ${isExecuting ? 'busy' : 'idle'}`} />
            <span>{isExecuting ? 'Busy' : 'Idle'}</span>
          </span>
          <span className="status-item">python3</span>
          <span className="status-item">~/projects</span>
        </div>
        <div className="status-right">
          <span className="status-item plot-toggle">
            <span>Plot: </span>
            <button
              className={`toggle ${plotMode === 'native' ? 'active' : ''}`}
              onClick={() => setPlotMode('native')}
            >
              Native
            </button>
            <button
              className={`toggle ${plotMode === 'capture' ? 'active' : ''}`}
              onClick={() => setPlotMode('capture')}
            >
              Capture
            </button>
          </span>
          <span className="status-item">
            Last: {lastDuration !== null ? `${Math.round(lastDuration)}ms` : '--'}
          </span>
        </div>
      </footer>
    </div>
  );
};

export default App;
