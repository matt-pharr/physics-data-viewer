/**
 * WelcomeScreen — full-screen overlay shown on startup when no project is loaded.
 *
 * Displays a logo placeholder, recent projects list, and buttons to create a
 * new project or open an existing one. Auto-dismisses when the user takes any
 * action. Clicking a recent project opens it directly.
 *
 * The kernel is NOT started until the user picks an action here. All actions
 * are delegated to callbacks owned by `App`.
 */

import React from 'react';

/** Entry in the recent projects list with optional language and name metadata. */
export interface RecentProject {
  path: string;
  language?: "python" | "julia";
  /** Project name from the manifest (falls back to folder name when absent). */
  name?: string;
}

/** Orphaned working dir with autosaved tree state from an unsaved session. */
export interface RecoverableSession {
  /** Absolute path to the orphan working dir. */
  dir: string;
  /** ISO timestamp of the autosave (used to compute the relative label). */
  timestamp: string;
}

interface WelcomeScreenProps {
  /** Recently opened projects (most recent first). */
  recentProjects: RecentProject[];
  /** Orphaned autosaves available for recovery (most recent first). */
  recoverableSessions: RecoverableSession[];
  /** Called when the user clicks a "New Project" button. Receives the chosen language. */
  onNewProject: (language: "python" | "julia") => void;
  /** Called when the user clicks "Open Project" (shows file picker). */
  onOpenProject: () => void;
  /** Called when the user clicks a recent project entry. */
  onOpenRecent: (path: string, language?: "python" | "julia") => void;
  /** Called when the user clicks "Recover" on an orphan autosave. */
  onRecoverSession: (orphanDir: string) => void;
  /** Called when the user clicks "Discard" on an orphan autosave. */
  onDiscardSession: (orphanDir: string) => void;
}

/** Short language badge for the recent projects list. */
function languageBadge(language?: "python" | "julia"): string {
  if (language === "julia") return "Julia";
  return "Python";
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

/** Coarse-grained "X ago" label suitable for autosave timestamps. */
function relativeTimeLabel(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toLocaleDateString();
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  recentProjects,
  recoverableSessions,
  onNewProject,
  onOpenProject,
  onOpenRecent,
  onRecoverSession,
  onDiscardSession,
}) => {
  const handleDiscard = (dir: string): void => {
    if (window.confirm(
      "Permanently discard this unsaved session? This cannot be undone.",
    )) {
      onDiscardSession(dir);
    }
  };

  return (
    <div className="welcome-overlay">
      <div className="welcome-card">
        {/* Logo */}
        <div className="welcome-logo">
          <svg className="welcome-logo-icon" width="72" height="72" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
            <circle cx="40" cy="40" r="36" fill="none" stroke="var(--text-secondary)" strokeWidth="2" opacity=".2"/>
            <circle cx="33" cy="33" r="14" fill="var(--accent)"/>
            <circle cx="47" cy="33" r="14" fill="var(--text-secondary)"/>
            <circle cx="33" cy="47" r="14" fill="var(--text-secondary)"/>
            <circle cx="47" cy="47" r="14" fill="var(--accent)"/>
          </svg>
          <h1 className="welcome-title">Physics Data Viewer</h1>
        </div>

        <div className="welcome-actions">
          <button
            className="btn btn-primary welcome-action-btn"
            onClick={() => onNewProject("python")}
          >
            New Python Project
          </button>
          <button
            className="btn btn-primary welcome-action-btn"
            onClick={() => onNewProject("julia")}
          >
            New Julia Project (experimental)
          </button>
          <button
            className="btn btn-secondary welcome-action-btn"
            onClick={onOpenProject}
          >
            Open Project…
          </button>
        </div>

        {recoverableSessions.length > 0 && (
          <div className="welcome-recent welcome-recoverable">
            <h2 className="welcome-recent-heading">Recoverable Unsaved Sessions</h2>
            <ul className="welcome-recent-list">
              {recoverableSessions.map((entry) => (
                <li key={entry.dir} className="welcome-recoverable-item">
                  <div className="welcome-recoverable-info" title={entry.dir}>
                    <span className="welcome-recent-name">
                      Autosaved {relativeTimeLabel(entry.timestamp)}
                    </span>
                    <span className="welcome-recent-path">{entry.dir}</span>
                  </div>
                  <div className="welcome-recoverable-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => onRecoverSession(entry.dir)}
                    >
                      Recover
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleDiscard(entry.dir)}
                    >
                      Discard
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recentProjects.length > 0 && (
          <div className="welcome-recent">
            <h2 className="welcome-recent-heading">Recent Projects</h2>
            <ul className="welcome-recent-list">
              {recentProjects.map((entry) => (
                <li key={entry.path}>
                  <button
                    className="welcome-recent-item"
                    onClick={() => onOpenRecent(entry.path, entry.language)}
                    title={entry.path}
                  >
                    <span className="welcome-recent-badge">[{languageBadge(entry.language)}]</span>
                    <span className="welcome-recent-name">{entry.name ?? projectName(entry.path)}</span>
                    <span className="welcome-recent-path">{projectDir(entry.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};
