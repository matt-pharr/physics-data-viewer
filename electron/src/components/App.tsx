/**
 * Main application component.
 * Integrates PythonEditor, OutputPanel, and StatePanel into a complete REPL UI.
 */

import React, { useState, useEffect } from 'react';
import PythonEditor from './CommandInput/PythonEditor';
import OutputPanel from './OutputDisplay/OutputPanel';
import StatePanel from './StateViewer/StatePanel';
import { useCommandExecution } from '../hooks/useCommandExecution';

const BACKEND_URL = 'http://localhost:8000';

export const App: React.FC = () => {
  const [sessionId, setSessionId] = useState<string>('');
  const [connectionError, setConnectionError] = useState<string>('');
  const {
    executeCommand,
    clearHistory,
    isExecuting,
    currentResult,
    history,
  } = useCommandExecution(BACKEND_URL, sessionId);

  // Initialize session on mount
  useEffect(() => {
    const initSession = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });

        if (!response.ok) {
          throw new Error(`Failed to create session: ${response.status}`);
        }

        const data = await response.json();
        setSessionId(data.session_id);
        setConnectionError('');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        setConnectionError(`Failed to connect to backend: ${message}`);
        console.error('Session initialization error:', error);
      }
    };

    initSession();
  }, []);

  const handleExecute = async (code: string) => {
    if (!sessionId) {
      console.error('No session ID available');
      return;
    }
    await executeCommand(code);
  };

  const handleClearOutput = () => {
    clearHistory();
  };

  if (connectionError) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: '#1e1e1e',
          color: '#f48771',
          fontFamily: 'sans-serif',
          padding: '20px',
          textAlign: 'center',
        }}
      >
        <div>
          <h2>⚠️ Connection Error</h2>
          <p>{connectionError}</p>
          <p style={{ color: '#858585', fontSize: '14px', marginTop: '20px' }}>
            Make sure the backend server is running:
            <br />
            <code style={{ backgroundColor: '#252526', padding: '4px 8px', borderRadius: '4px' }}>
              uvicorn platform.server.app:app --host 127.0.0.1 --port 8000
            </code>
          </p>
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: '#1e1e1e',
          color: '#d4d4d4',
          fontFamily: 'sans-serif',
        }}
      >
        Connecting to backend...
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: '#1e1e1e',
        color: '#d4d4d4',
        fontFamily: 'sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          backgroundColor: '#252526',
          borderBottom: '1px solid #3c3c3c',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: '18px', color: '#569cd6' }}>
            Physics Data Viewer - Python REPL
          </h1>
          <div style={{ fontSize: '11px', color: '#858585', marginTop: '4px' }}>
            Session: {sessionId.slice(0, 8)}...
          </div>
        </div>
        <button
          onClick={handleClearOutput}
          style={{
            padding: '6px 12px',
            backgroundColor: '#3c3c3c',
            color: '#d4d4d4',
            border: '1px solid #3c3c3c',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#505050';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#3c3c3c';
          }}
        >
          Clear Output
        </button>
      </div>

      {/* Main content area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left side: Editor and Output */}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          {/* Editor */}
          <div
            style={{
              borderBottom: '1px solid #3c3c3c',
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                backgroundColor: '#252526',
                borderBottom: '1px solid #3c3c3c',
                fontSize: '13px',
                fontWeight: 'bold',
              }}
            >
              Python Command Input
              <span style={{ color: '#858585', fontSize: '11px', marginLeft: '12px' }}>
                Ctrl+Enter to execute • ↑/↓ for history
              </span>
            </div>
            <PythonEditor
              sessionId={sessionId}
              backendUrl={BACKEND_URL}
              onExecute={handleExecute}
              height="250px"
            />
          </div>

          {/* Output */}
          <OutputPanel
            stdout={currentResult?.stdout}
            stderr={currentResult?.stderr}
            error={currentResult?.error}
            isExecuting={isExecuting}
          />
        </div>

        {/* Right side: State viewer */}
        <StatePanel state={currentResult?.state || {}} />
      </div>
    </div>
  );
};

export default App;
