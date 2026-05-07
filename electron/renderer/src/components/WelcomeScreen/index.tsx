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
        {/* Logo — paths copied verbatim from `assets/pdv-icon.svg`, with
            the same theme-aware color mapping used by the About tab so
            the two surfaces share one mark. The rounded-square backdrop
            from the desktop icon is omitted; the welcome screen sits on
            bg-primary so the alpha-particle stands on its own. */}
        <div className="welcome-logo">
          <svg className="welcome-logo-icon" width="80" height="80" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path
              fill="currentColor"
              opacity="0.1"
              d="M 987.428589 512 C 987.428589 774.571899 774.571899 987.428589 512 987.428589 C 249.428055 987.428589 36.57143 774.571899 36.57143 512 C 36.57143 249.42804 249.428055 36.571411 512 36.571411 C 774.571899 36.571411 987.428589 249.42804 987.428589 512 Z"
            />
            <path
              fill="currentColor"
              opacity="0.14"
              d="M 914.285706 512 C 914.285706 734.17627 734.17627 914.285706 512 914.285706 C 289.82373 914.285706 109.714287 734.17627 109.714287 512 C 109.714287 289.82373 289.82373 109.714294 512 109.714294 C 734.17627 109.714294 914.285706 289.82373 914.285706 512 Z"
            />
            <path
              fill="var(--accent)"
              d="M 603.428589 420.571411 C 603.428589 521.560669 521.560669 603.428589 420.571442 603.428589 C 319.582214 603.428589 237.714279 521.560669 237.714279 420.571411 C 237.714279 319.582153 319.582214 237.714294 420.571442 237.714294 C 521.560669 237.714294 603.428589 319.582153 603.428589 420.571411 Z"
            />
            <path
              fill="color-mix(in srgb, var(--accent) 60%, white)"
              d="M 786.285706 420.571411 C 786.285706 521.560669 704.417786 603.428589 603.428589 603.428589 C 502.439362 603.428589 420.571442 521.560669 420.571442 420.571411 C 420.571442 319.582153 502.439362 237.714294 603.428589 237.714294 C 704.417786 237.714294 786.285706 319.582153 786.285706 420.571411 Z"
            />
            <path
              fill="color-mix(in srgb, var(--accent) 60%, white)"
              d="M 603.428589 603.428589 C 603.428589 704.417725 521.560669 786.285706 420.571442 786.285706 C 319.582214 786.285706 237.714279 704.417725 237.714279 603.428589 C 237.714279 502.439331 319.582214 420.571411 420.571442 420.571411 C 521.560669 420.571411 603.428589 502.439331 603.428589 603.428589 Z"
            />
            <path
              fill="var(--accent)"
              d="M 786.285706 603.428589 C 786.285706 704.417725 704.417786 786.285706 603.428589 786.285706 C 502.439362 786.285706 420.571442 704.417725 420.571442 603.428589 C 420.571442 502.439331 502.439362 420.571411 603.428589 420.571411 C 704.417786 420.571411 786.285706 502.439331 786.285706 603.428589 Z"
            />
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
          {/* Julia is supported by the kernel side but the workflow is
              experimental; hidden from the welcome screen for the open
              beta to keep the UX focused. Re-enable when Julia is
              promoted past experimental. */}
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
