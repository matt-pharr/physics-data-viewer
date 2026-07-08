/**
 * StatusBar — Bottom chrome showing execution state, runtime, and connection.
 *
 * Displays kernel busy/idle status, active runtime path (Python or Julia),
 * project directory, connection indicator, and last execution duration.
 */

import React from 'react';
import type { ProgressPayload, UpdateStatus } from '../../types/pdv';

interface StatusBarProps {
  isExecuting: boolean;
  activeLanguage: 'python' | 'julia';
  /** Whether the active kernel runs in a per-project uv venv or a shared env. */
  environmentMode?: 'uv' | 'shared';
  pythonPath: string | undefined;
  juliaPath: string | undefined;
  kernelSpec: string | undefined;
  currentProjectDir: string | null;
  kernelStatus: 'idle' | 'starting' | 'ready' | 'error';
  lastDuration: number | null;
  progress: ProgressPayload | null;
  onRuntimeClick: () => void;
  /** Restart the active session. Rendered only while connected; the tree
   *  is snapshotted before teardown and restored afterwards. */
  onRestartSession?: () => void;
  lastChecksum: string | null;
  checksumMismatch: boolean;
  savedPdvVersion: string | null;
  runningPdvVersion: string | null;
  /** Timestamp (ms) of the most recent successful autosave, or null if none yet. */
  lastAutosaveAt: number | null;
  /** Resident-set-size of the active kernel subprocess, in bytes. Hidden when null. */
  kernelMemoryRss: number | null;
  /** Latest auto-update status. Status-bar badge shown when state is `available` or `downloaded`. */
  updateStatus: UpdateStatus | null;
  /** Click handler for the update-available badge — typically opens Settings → About. */
  onUpdateClick: () => void;
  /** True when at least one MCP agent client is currently connected. */
  mcpClientAttached: boolean;
}

/** Format a timestamp as HH:MM:SS in the user's locale. */
function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a byte count for status-bar display: "245 MB" or "1.4 GB" (1 decimal ≥1 GB). */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Application status bar at the bottom of the window. */
export const StatusBar: React.FC<StatusBarProps> = ({
  isExecuting,
  activeLanguage,
  environmentMode,
  pythonPath,
  juliaPath,
  kernelSpec,
  currentProjectDir,
  kernelStatus,
  lastDuration,
  progress,
  onRuntimeClick,
  onRestartSession,
  lastChecksum,
  checksumMismatch,
  savedPdvVersion,
  runningPdvVersion,
  lastAutosaveAt,
  kernelMemoryRss,
  updateStatus,
  onUpdateClick,
  mcpClientAttached,
}) => {
  const showUpdateBadge =
    updateStatus?.state === 'available' || updateStatus?.state === 'downloaded';
  const isUvProject = activeLanguage === 'python' && environmentMode === 'uv';
  const runtimeLabel = activeLanguage === 'julia'
    ? (juliaPath ?? 'julia')
    : isUvProject
      ? 'uv · project venv'
      : (pythonPath ?? kernelSpec ?? 'python3');
  const runtimeTitle = isUvProject
    ? 'Project-specific environment managed by uv'
    : 'Click to change runtime';

  const progressPct = progress ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <footer className="status-bar">
      {progress && (
        <div className="status-progress-track">
          <div className="status-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      )}
      <div className="status-left">
        <span className="status-item">{currentProjectDir ?? 'Unsaved Project'}</span>
        {showUpdateBadge && updateStatus && (
          <span
            className="status-item status-warning status-clickable"
            onClick={onUpdateClick}
            title={
              updateStatus.state === 'downloaded'
                ? `v${updateStatus.version ?? '?'} ready — restart to install`
                : `v${updateStatus.version ?? '?'} available`
            }
          >
            ⬆ {updateStatus.state === 'downloaded'
              ? `Update ready: v${updateStatus.version ?? '?'}`
              : `Update available: v${updateStatus.version ?? '?'}`}
          </span>
        )}
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
        {lastAutosaveAt !== null && (
          <span
            className="status-item"
            title="Time of the most recent autosave"
          >
            Autosaved at {formatTimeOfDay(lastAutosaveAt)}
          </span>
        )}
      </div>
      <div className="status-right">
        {mcpClientAttached && (
          <span
            className="status-item"
            title="AI agent connected via MCP"
            data-testid="mcp-client-indicator"
          >
            <span className="status-dot mcp-attached" />
            <span>Agent</span>
          </span>
        )}
        <span
          className="status-item status-clickable"
          onClick={onRuntimeClick}
          title={runtimeTitle}
        >
          {runtimeLabel}
        </span>
        {kernelMemoryRss !== null && (
          <span
            className="status-item"
            title="Resident memory used by the kernel subprocess"
          >
            RAM: {formatBytes(kernelMemoryRss)}
          </span>
        )}
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
        <span className="status-item">
          Last: {lastDuration !== null ? `${Math.round(lastDuration)}ms` : '--'}
        </span>
        {kernelStatus === 'ready' && onRestartSession && (
          <span
            className="status-item status-clickable"
            onClick={onRestartSession}
            title="Restart the session — the tree is snapshotted and restored automatically"
            data-testid="restart-session"
          >
            ⟳ Restart
          </span>
        )}
        <span
          className={`status-item ${kernelStatus === 'ready' ? 'status-connected' : kernelStatus === 'error' ? 'status-error' : ''}`}
          data-testid="kernel-status"
          data-status={kernelStatus}
        >
          ● {kernelStatus === 'ready' ? 'Connected' : kernelStatus === 'starting' ? 'Starting...' : 'Disconnected'}
        </span>
      </div>
    </footer>
  );
};
