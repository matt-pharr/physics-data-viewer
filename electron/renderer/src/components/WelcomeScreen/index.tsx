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
  /**
   * SSH alias the project lives on, or null for this machine. Remote entries
   * carry no manifest metadata: reading it means connecting to the host
   * first, which is not something the welcome screen should do on its own.
   */
  host?: string | null;
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
  /** Kernel language from the autosave's sidecar manifest (absent for
   *  pre-sidecar autosaves; recovery defaults to python). */
  language?: "python" | "julia";
  /** Per-project environment mode when the orphan holds env files
   *  (pyproject.toml → "uv", Project.toml → "pkg"); recovery boots the
   *  kernel with that environment active instead of shared mode. */
  envMode?: "uv" | "pkg";
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
  onOpenRecent: (path: string, host?: string | null) => void;
  /**
   * Host the session currently runs on, or null for this machine. The
   * full-window welcome covers the status bar — without this line the
   * post-swap landing is pixel-identical to a fresh local launch, and the
   * user's next "New Project" targets a machine named nowhere on screen.
   */
  remoteHost?: string | null;
  /** False while the remote session is unreachable — the banner must not
   *  claim "Connected" over a dead channel. */
  remoteReachable?: boolean;
  /** Set when the session runs remotely WITHOUT the configured setup
   *  script. Shown as its own warning banner: the failure otherwise
   *  surfaces later as mysteriously missing modules. */
  remoteSetupWarning?: string | null;
  /** Called when the user clicks "Recover" on an orphan autosave. Receives
   *  the autosave's kernel language so the right kernel boots, and its env
   *  mode so a uv/pkg session recovers with its environment active. */
  onRecoverSession: (
    orphanDir: string,
    language?: "python" | "julia",
    envMode?: "uv" | "pkg",
  ) => void;
  /** Called when the user clicks "Discard" on an orphan autosave. */
  onDiscardSession: (orphanDir: string) => void;
  /** Called when the user clicks "Clear" beneath the recent-projects list. */
  onClearRecents: () => void;
  /**
   * True when remote sessions are enabled (the PDV_REMOTE release gate).
   * Hides the Connect to Host button entirely when false, mirroring the
   * shell's gated File-menu entry.
   */
  remoteEnabled?: boolean;
  /** Called when the user clicks "Connect to Host…" (or "Reconnect to
   *  '<host>'…" while the remote session is unreachable). Opens the
   *  connect dialog; it never connects directly. */
  onConnectHost: () => void;
  /** Called when the user clicks "Disconnect from '<host>'" while the
   *  session runs remotely. Returns this window to a fresh local session;
   *  the remote session keeps running on the host. */
  onDisconnectHost: () => void;
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
  remoteHost,
  remoteReachable,
  remoteSetupWarning,
  onNewProject,
  onOpenProject,
  onOpenRecent,
  onRecoverSession,
  onDiscardSession,
  onClearRecents,
  remoteEnabled,
  onConnectHost,
  onDisconnectHost,
}) => {
  const handleDiscard = (dir: string): void => {
    if (window.confirm(
      "Permanently discard this unsaved session? This cannot be undone.",
    )) {
      onDiscardSession(dir);
    }
  };

  const handleClearRecents = (): void => {
    if (window.confirm("Clear the list of recent projects? Your project files are not affected.")) {
      onClearRecents();
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

        {remoteHost && (
          <div
            className={
              remoteReachable !== false
                ? "welcome-remote-banner"
                : "welcome-remote-banner welcome-remote-banner-warning"
            }
          >
            {remoteReachable !== false ? (
              <>
                Connected to <strong>{remoteHost}</strong> — new and opened
                projects will run there. Disconnecting keeps the session
                running for later.
              </>
            ) : (
              <>
                Your session lives on <strong>{remoteHost}</strong> but is
                unreachable right now — use Reconnect below.
              </>
            )}
          </div>
        )}

        {remoteHost && remoteSetupWarning && (
          <div className="welcome-remote-banner welcome-remote-banner-warning">
            {remoteSetupWarning}
          </div>
        )}

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
            New Julia Project
          </button>
          <button
            className="btn btn-secondary welcome-action-btn"
            onClick={onOpenProject}
          >
            Open Project…
          </button>
          {remoteEnabled &&
            // Three states, keyed on the same values as the banner above:
            // no remote session → connect; running remotely → disconnect
            // (session keeps running on the host); unreachable → reconnect
            // via the dialog, which owns the auth flow.
            (!remoteHost ? (
              <button
                className="btn btn-secondary welcome-action-btn"
                onClick={onConnectHost}
              >
                Connect to Host…
              </button>
            ) : remoteReachable !== false ? (
              <button
                className="btn btn-secondary welcome-action-btn welcome-remote-btn"
                title={`Disconnect from ‘${remoteHost}’ — the session keeps running there`}
                onClick={onDisconnectHost}
              >
                Disconnect from ‘{remoteHost}’
              </button>
            ) : (
              <button
                className="btn btn-secondary welcome-action-btn welcome-remote-btn"
                title={`Reconnect to ‘${remoteHost}’`}
                onClick={onConnectHost}
              >
                Reconnect to ‘{remoteHost}’…
              </button>
            ))}
        </div>

        {recoverableSessions.length > 0 && (
          <div className="welcome-recent welcome-recoverable">
            <h2 className="welcome-recent-heading">Recoverable Unsaved Sessions</h2>
            <ul className="welcome-recent-list">
              {recoverableSessions.map((entry) => (
                <li key={entry.dir} className="welcome-recoverable-item">
                  <div className="welcome-recoverable-info" title={entry.dir}>
                    <span className="welcome-recent-name">
                      Autosaved {relativeTimeLabel(entry.timestamp)}{' '}
                      <span className="welcome-recent-badge">[{languageBadge(entry.language)}]</span>
                    </span>
                    <span className="welcome-recent-path">{entry.dir}</span>
                  </div>
                  <div className="welcome-recoverable-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => onRecoverSession(entry.dir, entry.language, entry.envMode)}
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
            <div className="welcome-recent-header">
              <h2 className="welcome-recent-heading">Recent Projects</h2>
              <button
                type="button"
                className="welcome-recent-clear"
                onClick={handleClearRecents}
                aria-label="Clear recent projects list"
              >
                Clear
              </button>
            </div>
            <ul className="welcome-recent-list">
              {recentProjects.map((entry) => (
                // Keyed on host + path: the same path on two machines is two
                // different projects, so path alone would collide.
                <li key={`${entry.host ?? ''}:${entry.path}`}>
                  <button
                    className="welcome-recent-item"
                    onClick={() => onOpenRecent(entry.path, entry.host)}
                    title={entry.host ? `${entry.host}:${entry.path}` : entry.path}
                  >
                    {/* Remote entries show BOTH language and host — the host
                        must never replace the language (a user still wants to
                        know Python vs Julia). The language rides the recents
                        entry itself, recorded at remember-time; entries from
                        before that field existed have genuinely unknown
                        language and show only the host rather than a guess. */}
                    {(entry.host === null || entry.language) && (
                      <span className="welcome-recent-badge">
                        [{languageBadge(entry.language)}]
                      </span>
                    )}
                    {entry.host && (
                      <span className="welcome-recent-badge">[{entry.host}]</span>
                    )}
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
