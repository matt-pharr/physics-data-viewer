/**
 * StatusBar — Bottom chrome showing execution state, runtime, and connection.
 *
 * Displays kernel busy/idle status, active runtime path (Python or Julia),
 * project directory, connection indicator, and last execution duration.
 */

import React from 'react';
import type { ProgressPayload } from '../../types/pdv';

interface StatusBarProps {
  isExecuting: boolean;
  activeLanguage: 'python' | 'julia';
  pythonPath: string | undefined;
  juliaPath: string | undefined;
  kernelSpec: string | undefined;
  currentProjectDir: string | null;
  kernelStatus: 'idle' | 'starting' | 'ready' | 'error';
  lastDuration: number | null;
  progress: ProgressPayload | null;
  onRuntimeClick: () => void;
  lastChecksum: string | null;
  checksumMismatch: boolean;
  savedPdvVersion: string | null;
  runningPdvVersion: string | null;
}

/** Application status bar at the bottom of the window. */
export const StatusBar: React.FC<StatusBarProps> = ({
  isExecuting,
  activeLanguage,
  pythonPath,
  juliaPath,
  kernelSpec,
  currentProjectDir,
  kernelStatus,
  lastDuration,
  progress,
  onRuntimeClick,
  lastChecksum,
  checksumMismatch,
  savedPdvVersion,
  runningPdvVersion,
}) => {
  const runtimeLabel = activeLanguage === 'julia'
    ? (juliaPath ?? 'julia')
    : (pythonPath ?? kernelSpec ?? 'python3');

  const progressPct = progress ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <footer className="status-bar">
      {progress && (
        <div className="status-progress-track">
          <div className="status-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      )}
      <div className="status-left">
        <span className="status-item">
          {progress ? (
            <>
              <span className="status-dot busy" />
              <span>
                {progress.phase} {progress.current}/{progress.total}
              </span>
            </>
          ) : (
            <>
              <span className={`status-dot ${isExecuting ? 'busy' : 'idle'}`} />
              <span>{isExecuting ? 'Busy' : 'Idle'}</span>
            </>
          )}
        </span>
        <span
          className="status-item status-clickable"
          onClick={onRuntimeClick}
          title="Click to change runtime"
        >
          {runtimeLabel}
        </span>
        <span className="status-item">{currentProjectDir ?? 'Unsaved Project'}</span>
      </div>
      <div className="status-right">
        {savedPdvVersion && runningPdvVersion && savedPdvVersion !== runningPdvVersion && (
          <span
            className="status-item status-warning"
            title="Project was saved with a different PDV version"
          >
            Saved: v{savedPdvVersion} | Running: v{runningPdvVersion}
          </span>
        )}
        {lastChecksum && (
          <span
            className={`status-item ${checksumMismatch ? 'status-warning' : ''}`}
            title={checksumMismatch ? 'Checksum mismatch — data may have changed since last save' : 'Project checksum'}
          >
            {checksumMismatch ? '⚠' : '◆'} {lastChecksum}
          </span>
        )}
        <span className={`status-item ${kernelStatus === 'ready' ? 'status-connected' : kernelStatus === 'error' ? 'status-error' : ''}`}>
          ● {kernelStatus === 'ready' ? 'Connected' : kernelStatus === 'starting' ? 'Starting...' : 'Disconnected'}
        </span>
        <span className="status-item">
          Last: {lastDuration !== null ? `${Math.round(lastDuration)}ms` : '--'}
        </span>
      </div>
    </footer>
  );
};
