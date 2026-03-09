/**
 * WelcomeScreen — full-screen overlay shown on startup when no project is loaded.
 *
 * Displays a logo placeholder, recent projects list, and buttons to create a
 * new project or open an existing one. Auto-dismisses when the user takes any
 * action. Clicking a recent project opens it directly, skipping the unsaved
 * changes dialog since the session is pristine.
 *
 * Does NOT manage project state — all actions are delegated to callbacks
 * owned by `App`.
 */

import React from 'react';

interface WelcomeScreenProps {
  /** Recently opened project directory paths (most recent first). */
  recentProjects: string[];
  /** Called when the user clicks "New Project". */
  onNewProject: () => void;
  /** Called when the user clicks "Open Project" (shows file picker). */
  onOpenProject: () => void;
  /** Called when the user clicks a recent project entry. */
  onOpenRecent: (path: string) => void;
  /** Whether the kernel is ready (buttons disabled until true). */
  kernelReady: boolean;
}

/** Extracts the project folder name from an absolute path. */
function projectName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** Formats the parent directory for display beneath the project name. */
function projectDir(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return path;
  return '/' + parts.slice(0, -1).join('/');
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  recentProjects,
  onNewProject,
  onOpenProject,
  onOpenRecent,
  kernelReady,
}) => {
  return (
    <div className="welcome-overlay">
      <div className="welcome-card">
        {/* Logo placeholder */}
        <div className="welcome-logo">
          <span className="welcome-logo-icon">⚛</span>
          <h1 className="welcome-title">Physics Data Viewer</h1>
        </div>

        <div className="welcome-actions">
          <button
            className="btn btn-primary welcome-action-btn"
            onClick={onNewProject}
            disabled={!kernelReady}
          >
            New Project
          </button>
          <button
            className="btn btn-secondary welcome-action-btn"
            onClick={onOpenProject}
            disabled={!kernelReady}
          >
            Open Project…
          </button>
        </div>

        {recentProjects.length > 0 && (
          <div className="welcome-recent">
            <h2 className="welcome-recent-heading">Recent Projects</h2>
            <ul className="welcome-recent-list">
              {recentProjects.map((path) => (
                <li key={path}>
                  <button
                    className="welcome-recent-item"
                    onClick={() => onOpenRecent(path)}
                    disabled={!kernelReady}
                    title={path}
                  >
                    <span className="welcome-recent-name">{projectName(path)}</span>
                    <span className="welcome-recent-path">{projectDir(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!kernelReady && (
          <p className="welcome-status">Starting kernel…</p>
        )}
      </div>
    </div>
  );
};
