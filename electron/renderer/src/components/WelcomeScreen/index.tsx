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

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  recentProjects,
  onNewProject,
  onOpenProject,
  onOpenRecent,
}) => {
  return (
    <div className="welcome-overlay">
      <div className="welcome-card">
        {/* Logo */}
        <div className="welcome-logo">
          <svg className="welcome-logo-icon" width="72" height="72" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
            <path fill="none" stroke="currentColor" strokeWidth="6" d="M 467.78 245.78 C 467.78 368.39 368.39 467.78 245.78 467.78 C 123.17 467.78 23.78 368.39 23.78 245.78 C 23.78 123.17 123.17 23.78 245.78 23.78 C 368.39 23.78 467.78 123.17 467.78 245.78 Z"/>
            <path fill="currentColor" stroke="none" d="M 312.45 397.15 C 270.19 415.82 220.8 396.69 202.14 354.43 C 183.47 312.18 202.6 262.79 244.86 244.12 C 287.12 225.46 336.5 244.59 355.17 286.84 C 373.83 329.1 354.71 378.49 312.45 397.15 Z"/>
            <path fill="currentColor" stroke="none" d="M 246.59 248.05 C 204.33 266.71 154.95 247.59 136.28 205.33 C 117.62 163.07 136.74 113.68 179 95.02 C 221.26 76.35 270.65 95.48 289.31 137.74 C 307.98 180 288.85 229.38 246.59 248.05 Z"/>
            <path fill="none" stroke="currentColor" strokeWidth="29" d="M 354.07 289.67 C 311.82 308.34 262.43 289.21 243.76 246.95 C 225.1 204.7 244.23 155.31 286.48 136.64 C 328.74 117.98 378.13 137.11 396.79 179.36 C 415.46 221.62 396.33 271.01 354.07 289.67 Z"/>
            <path fill="none" stroke="currentColor" strokeWidth="29" d="M 204.97 355.53 C 162.71 374.19 113.32 355.07 94.66 312.81 C 75.99 270.55 95.12 221.16 137.38 202.5 C 179.64 183.84 229.02 202.96 247.69 245.22 C 266.35 287.48 247.23 336.87 204.97 355.53 Z"/>
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
