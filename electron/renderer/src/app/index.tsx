import React, { useState } from 'react';

type Tab = 'tree' | 'namespace' | 'modules';
type PlotMode = 'native' | 'capture';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('tree');
  const [plotMode, setPlotMode] = useState<PlotMode>('native');
  const [commandTabs, setCommandTabs] = useState<number[]>([1]);
  const [activeCommandTab, setActiveCommandTab] = useState(1);

  const addCommandTab = () => {
    const newId = Math.max(...commandTabs) + 1;
    setCommandTabs([...commandTabs, newId]);
    setActiveCommandTab(newId);
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
          {/* Console / Log */}
          <section className="console-pane">
            <div className="pane-header">
              <h2>Console</h2>
              <div className="pane-actions">
                <button className="btn btn-secondary">Export</button>
                <button className="btn btn-secondary">Clear</button>
              </div>
            </div>
            <div className="console-content">
              <div className="console-empty">
                <p>No output yet</p>
                <p className="hint">Execution results will appear here</p>
              </div>
            </div>
          </section>

          {/* Horizontal resizer */}
          <div className="horizontal-resizer" />

          {/* Command Box */}
          <section className="command-pane">
            <div className="pane-header">
              <h2>Command</h2>
              <div className="command-tabs">
                {commandTabs.map((tabId) => (
                  <button
                    key={tabId}
                    className={`tab ${activeCommandTab === tabId ? 'active' : ''}`}
                    onClick={() => setActiveCommandTab(tabId)}
                  >
                    {tabId}
                  </button>
                ))}
                <button className="tab add" onClick={addCommandTab}>
                  +
                </button>
              </div>
              <div className="pane-actions">
                <button className="btn btn-primary">Execute</button>
                <button className="btn btn-secondary">Clear</button>
              </div>
            </div>
            <div className="command-content">
              <div className="command-editor-placeholder">
                <p>Monaco Editor</p>
                <p className="hint">Code editor will be integrated in Step 4</p>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Status bar */}
      <footer className="status-bar">
        <div className="status-left">
          <span className="status-item">
            <span className="status-dot idle" />
            <span>Idle</span>
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
          <span className="status-item">Last: --</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
