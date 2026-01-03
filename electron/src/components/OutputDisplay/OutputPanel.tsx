/**
 * Output panel component for displaying command execution results.
 * Shows stdout, stderr, and error messages with syntax highlighting.
 */

import React from 'react';

interface OutputPanelProps {
  stdout?: string;
  stderr?: string;
  error?: string | null;
  isExecuting?: boolean;
}

export const OutputPanel: React.FC<OutputPanelProps> = ({
  stdout = '',
  stderr = '',
  error = null,
  isExecuting = false,
}) => {
  const hasContent = stdout || stderr || error;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1e1e1e',
        color: '#d4d4d4',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #3c3c3c',
          backgroundColor: '#252526',
          fontWeight: 'bold',
          fontSize: '13px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span>Output</span>
        {isExecuting && (
          <span style={{ color: '#4ec9b0', fontSize: '11px' }}>
            ⟳ Executing...
          </span>
        )}
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px',
          fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
          fontSize: '13px',
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
        }}
      >
        {!hasContent && !isExecuting && (
          <div style={{ color: '#858585', fontStyle: 'italic' }}>
            No output yet. Execute a command to see results.
          </div>
        )}

        {error && (
          <div
            style={{
              color: '#f48771',
              backgroundColor: '#5a1d1d',
              padding: '8px',
              borderRadius: '4px',
              marginBottom: '8px',
              borderLeft: '3px solid #f48771',
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
              ❌ Error:
            </div>
            <div>{error}</div>
          </div>
        )}

        {stderr && (
          <div
            style={{
              color: '#ce9178',
              marginBottom: stdout ? '12px' : 0,
            }}
          >
            {stderr}
          </div>
        )}

        {stdout && (
          <div style={{ color: '#d4d4d4' }}>
            {stdout}
          </div>
        )}
      </div>
    </div>
  );
};

export default OutputPanel;
