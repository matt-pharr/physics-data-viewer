/**
 * StatusBar — Bottom chrome showing execution state, runtime, and connection.
 *
 * Displays kernel busy/idle status, Python runtime path, project directory,
 * connection indicator, and last execution duration.
 */

import React from 'react';

interface StatusBarProps {
  isExecuting: boolean;
  pythonPath: string | undefined;
  kernelSpec: string | undefined;
  currentProjectDir: string | null;
  kernelStatus: 'idle' | 'starting' | 'ready' | 'error';
  lastDuration: number | null;
  onRuntimeClick: () => void;
}

/** Application status bar at the bottom of the window. */
export const StatusBar: React.FC<StatusBarProps> = ({
  isExecuting,
  pythonPath,
  kernelSpec,
  currentProjectDir,
  kernelStatus,
  lastDuration,
  onRuntimeClick,
}) => (
  <footer className="status-bar">
    <div className="status-left">
      <span className="status-item">
        <span className={`status-dot ${isExecuting ? 'busy' : 'idle'}`} />
        <span>{isExecuting ? 'Busy' : 'Idle'}</span>
      </span>
      <span
        className="status-item status-clickable"
        onClick={onRuntimeClick}
        title="Click to change runtime"
      >
        {pythonPath ?? kernelSpec ?? 'python3'}
      </span>
      <span className="status-item">{currentProjectDir ?? 'Unsaved Project'}</span>
    </div>
    <div className="status-right">
      <span className={`status-item ${kernelStatus === 'ready' ? 'status-connected' : kernelStatus === 'error' ? 'status-error' : ''}`}>
        ● {kernelStatus === 'ready' ? 'Connected' : kernelStatus === 'starting' ? 'Starting...' : 'Disconnected'}
      </span>
      <span className="status-item">
        Last: {lastDuration !== null ? `${Math.round(lastDuration)}ms` : '--'}
      </span>
    </div>
  </footer>
);
