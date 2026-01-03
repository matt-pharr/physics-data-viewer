/**
 * State panel component for displaying session variables.
 * Shows the current Python namespace state.
 */

import React from 'react';

interface StatePanelProps {
  state: Record<string, any>;
}

export const StatePanel: React.FC<StatePanelProps> = ({ state }) => {
  const filteredState = Object.entries(state).filter(
    ([key]) => !key.startsWith('__')
  );

  const formatValue = (value: any): string => {
    if (value === null) return 'None';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      return `{${keys.length} keys}`;
    }
    return String(value);
  };

  const getTypeColor = (value: any): string => {
    if (value === null) return '#569cd6';
    if (typeof value === 'string') return '#ce9178';
    if (typeof value === 'number') return '#b5cea8';
    if (typeof value === 'boolean') return '#569cd6';
    if (Array.isArray(value)) return '#4ec9b0';
    if (typeof value === 'object') return '#4ec9b0';
    return '#d4d4d4';
  };

  return (
    <div
      style={{
        width: '300px',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1e1e1e',
        borderLeft: '1px solid #3c3c3c',
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
        }}
      >
        Session Variables ({filteredState.length})
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '8px',
        }}
      >
        {filteredState.length === 0 ? (
          <div
            style={{
              color: '#858585',
              fontStyle: 'italic',
              padding: '8px',
              fontSize: '12px',
            }}
          >
            No variables defined yet
          </div>
        ) : (
          <div style={{ fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace", fontSize: '12px' }}>
            {filteredState.map(([key, value]) => (
              <div
                key={key}
                style={{
                  padding: '6px 8px',
                  marginBottom: '4px',
                  backgroundColor: '#252526',
                  borderRadius: '4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div
                  style={{
                    color: '#9cdcfe',
                    fontWeight: 'bold',
                  }}
                >
                  {key}
                </div>
                <div
                  style={{
                    color: getTypeColor(value),
                    marginLeft: '8px',
                    wordBreak: 'break-word',
                  }}
                >
                  {formatValue(value)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default StatePanel;
