/**
 * AboutTab — version info, update checks, and project links.
 *
 * Presentational tab body extracted from SettingsDialog. Update actions go
 * straight to `window.pdv.updater` / `window.pdv.about`; the parent owns
 * the version string and update status (they arrive via push subscriptions
 * that outlive tab switches).
 */

import React from 'react';
import type { UpdateStatus } from '../../types';

interface AboutTabProps {
  /** App version string (or a placeholder while loading). */
  appVersion: string;
  /** Current auto-updater state, fed by the parent's push subscription. */
  updateInfo: UpdateStatus;
  /** Wraps installUpdate so the caller can prompt about unsaved changes. */
  onInstallUpdate?: () => void;
}

/** About tab body (logo, version, updates, links). */
export const AboutTab: React.FC<AboutTabProps> = ({
  appVersion,
  updateInfo,
  onInstallUpdate,
}) => (
  <div className="settings-about">
    <div className="about-hero">
      {/* Paths copied verbatim from `assets/pdv-icon.svg` (the
          desktop app icon). The rounded-square background path
          is omitted — the About tab already sits on the dialog
          bg so the mark works floating. Theme-aware color
          mapping:
            • Two faint electron-shell rings → `currentColor`
              at the asset's original 0.10 / 0.14 opacities.
            • Darker nucleons (TL, BR) → `var(--accent)`.
            • Lighter nucleons (TR, BL) → an opaque paler
              accent via `color-mix`. Using opacity instead
              broke the two-tone effect: where a translucent
              lighter nucleon overlapped a fully-opaque darker
              one (both `var(--accent)`), the blend collapsed
              to solid accent and the lighter circle visibly
              "bit into" the darker neighbor. Mixing with
              white at the fill layer produces a separate
              opaque color, matching the asset's original
              #afa9ec-on-top-of-#7f77dd behaviour. */}
      <svg
        className="about-hero-logo"
        viewBox="0 0 1024 1024"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
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
      <div className="about-hero-text">
        <div className="about-name-line">Physics Data Viewer v{appVersion}</div>
        <div className="about-build-line">
          Build {__BUILD_SHA__} · {new Date(__BUILD_TIME__).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
        </div>
      </div>
    </div>

    <div className="about-row">
      <span className="about-label">Updates</span>
      <div className="about-check-row">
        {updateInfo.state === 'idle' && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void window.pdv.updater.checkForUpdates()}
          >
            Check now
          </button>
        )}
        {updateInfo.state === 'checking' && (
          <span className="about-update-status">Checking for updates...</span>
        )}
        {updateInfo.state === 'not-available' && (
          <span className="about-update-status about-update-status--success">Up to date</span>
        )}
        {updateInfo.state === 'available' && (
          <>
            <span className="about-update-status">v{updateInfo.version} available</span>
            {updateInfo.canAutoUpdate !== false ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void window.pdv.updater.downloadUpdate()}
              >
                Download
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void window.pdv.updater.openReleasesPage()}
              >
                View on GitHub
              </button>
            )}
          </>
        )}
        {updateInfo.state === 'downloading' && (
          <span className="about-update-status about-progress">
            Downloading... {updateInfo.progress != null ? `${updateInfo.progress}%` : ''}
          </span>
        )}
        {updateInfo.state === 'downloaded' && (
          <>
            <span className="about-update-status about-update-status--success">
              v{updateInfo.version} ready
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (onInstallUpdate) {
                  onInstallUpdate();
                } else {
                  void window.pdv.updater.installUpdate();
                }
              }}
            >
              Restart to update
            </button>
          </>
        )}
        {updateInfo.state === 'error' && (
          <>
            <span className="about-update-status about-update-status--error">
              {updateInfo.error ?? 'Update check failed'}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void window.pdv.updater.checkForUpdates()}
            >
              Retry
            </button>
          </>
        )}
      </div>
    </div>

    <div className="about-links">
      <button
        type="button"
        className="about-link"
        onClick={() => void window.pdv.about.openDocsPage()}
      >
        Docs
      </button>
      <span className="about-link-sep">·</span>
      <button
        type="button"
        className="about-link"
        onClick={() => void window.pdv.about.openRepoPage()}
      >
        Source
      </button>
      <span className="about-link-sep">·</span>
      <button
        type="button"
        className="about-link"
        onClick={() => void window.pdv.about.openIssuesPage()}
      >
        Report a bug
      </button>
      <span className="about-link-sep">·</span>
      <button
        type="button"
        className="about-link"
        onClick={() => void window.pdv.updater.openReleasesPage()}
      >
        Releases
      </button>
    </div>
  </div>
);
