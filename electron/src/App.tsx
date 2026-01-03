import React, { useState, useEffect } from 'react';
import { PythonEditor } from './components/CommandInput/PythonEditor';
import { BackendClient, ExecuteResult } from './api/client';
import './App.css';

export const App: React.FC = () => {
  const [client] = useState(() => new BackendClient('http://localhost:8000'));
  const [isConnected, setIsConnected] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const handleExecute = async (code: string) => {
    if (!isConnected) {
      setError('Not connected to backend');
      return;
    }

    try {
      const result: ExecuteResult = await client.execute(code);
      
      // Add to output log
      const newOutput = [
        `>>> ${code}`,
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
          <h2>Command Input</h2>
          {error && (
            <div className="error-message">
              {error}
            </div>
          )}
          {isConnected ? (
            <PythonEditor
              onExecute={handleExecute}
              client={client}
              height="200px"
            />
          ) : (
            <div className="loading">Connecting to backend...</div>
          )}
        </div>
      </main>
    </div>
  );
};
