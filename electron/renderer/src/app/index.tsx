import React from 'react';

const App: React.FC = () => {
  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <h1>Physics Data Viewer</h1>
        <div className="connection-status connected">● Connected</div>
      </header>

      {/* Main content */}
      <main className="app-main">
        {/* Left pane:  Tree */}
        <aside className="left-pane">
          <div className="pane-tabs">
            <button className="tab active">Tree</button>
            <button className="tab">Namespace</button>
            <button className="tab">Modules</button>
          </div>
          <div className="tree-container">
            <div className="tree-header">
              <span className="tree-col key">Key</span>
              <span className="tree-col type">Type</span>
              <span className="tree-col preview">Preview</span>
            </div>
            <div className="tree-content">
              <div className="tree-empty">Tree (stub) - No data loaded</div>
            </div>
          </div>
        </aside>

        {/* Right pane: Console + Command Box */}
        <div className="right-pane">
          {/* Console / Log */}
          <section className="console-pane">
            <div className="pane-header">
              <h2>Console</h2>
              <button className="btn-clear">Clear</button>
            </div>
            <div className="console-content">
              <div className="console-empty">Console (stub) - No output yet</div>
            </div>
          </section>

          {/* Horizontal resizer */}
          <div className="horizontal-resizer" />

          {/* Command Box */}
          <section className="command-pane">
            <div className="pane-header">
              <h2>Command</h2>
              <div className="command-tabs">
                <button className="tab active">1</button>
                <button className="tab">2</button>
                <button className="tab add">+</button>
              </div>
              <div className="command-actions">
                <button className="btn-execute">Execute</button>
                <button className="btn-clear">Clear</button>
              </div>
            </div>
            <div className="command-content">
              <div className="command-editor-stub">
                Command Box (stub) - Monaco editor will be here
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Status bar */}
      <footer className="status-bar">
        <span className="status-item kernel-status">
          <span className="status-dot idle" /> Idle
        </span>
        <span className="status-item">python3</span>
        <span className="status-item">~/projects</span>
        <span className="status-item plot-mode">
          Plot:  <button className="toggle active">Native</button>
          <button className="toggle">Capture</button>
        </span>
        <span className="status-item last-exec">Last:  --</span>
      </footer>
    </div>
  );
};

export default App;