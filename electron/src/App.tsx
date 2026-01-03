import React, { useState, useEffect } from 'react';
import { PythonEditor } from './components/CommandInput/PythonEditor';
import { BackendClient, ExecuteResult } from './api/client';
import './App.css';

interface CommandBox {
  id: number;
  code: string;
}

export const App: React.FC = () => {
  const [client] = useState(() => new BackendClient('http://localhost:8000'));
  const [isConnected, setIsConnected] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [commandBoxes, setCommandBoxes] = useState<CommandBox[]>([{ id: 1, code: '' }]);
  const [activeBoxId, setActiveBoxId] = useState(1);
  const [nextId, setNextId] = useState(2);

  useEffect(() => {
    // Connect to backend on mount
    client
      .connect()
      .then(() => {
        setIsConnected(true);
        console.log('Connected to backend');
      })
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
      </main>
    </div>
  );
};
