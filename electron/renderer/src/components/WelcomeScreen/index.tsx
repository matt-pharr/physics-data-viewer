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

/** Entry in the recent projects list with optional language metadata. */
export interface RecentProject {
  path: string;
  language?: "python" | "julia";
}

interface WelcomeScreenProps {
  /** Recently opened projects (most recent first). */
  recentProjects: RecentProject[];
  /** Called when the user clicks a "New Project" button. Receives the chosen language. */
  onNewProject: (language: "python" | "julia") => void;
  /** Called when the user clicks "Open Project" (shows file picker). */
  onOpenProject: () => void;
  /** Called when the user clicks a recent project entry. */
  onOpenRecent: (path: string, language?: "python" | "julia") => void;
}

/** Short language badge for the recent projects list. */
function languageBadge(language?: "python" | "julia"): string {
  if (language === "julia") return "Julia";
  // return "Python";
  if (language === "python") return "Python";
  else return String(language);
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
                    <span className="welcome-recent-name">{projectName(entry.path)}</span>
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
