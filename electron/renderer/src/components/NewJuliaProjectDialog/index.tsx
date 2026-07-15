/**
 * NewJuliaProjectDialog — creation-time environment setup for a new Julia
 * project (§10.6.5), the Julia sibling of NewProjectDialog.
 *
 * Julia projects are always Pkg-managed (§10.6.1's additivity means there is
 * no uv/shared mode fork to offer), so the dialog carries only the two
 * uv-parity fields: the **Julia version** — a dropdown over the supported
 * minors, with installed juliaup channels marked and missing ones downloaded
 * automatically via `juliaup add` behind the launch overlay — and the
 * **initial package list** added to the fresh project environment.
 *
 * When juliaup is not installed the version choice collapses to the
 * configured runtime, with a pointer at the selector's one-click juliaup
 * install (§10.7.5).
 *
 * Follows the standard modal-overlay pattern (NewProjectDialog, SaveAsDialog).
 */

import React, { useEffect, useState } from 'react';
import type { JuliaupChannel } from '../../types';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface NewJuliaProjectDialogProps {
  /** Create a pkg-mode project with the chosen version and packages. */
  onCreate: (opts: { juliaVersion?: string; packages: string[] }) => void;
  /** Called when the user cancels (Escape, ×, backdrop, Cancel). */
  onCancel: () => void;
}

/** Split a comma/whitespace-separated package string into specs. */
function parsePackages(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `"1.11.6"` → `"1.11"`; null for non-version strings. */
function minorOf(version: string): string | null {
  return version.match(/^(\d+\.\d+)/)?.[1] ?? null;
}

export const NewJuliaProjectDialog: React.FC<NewJuliaProjectDialogProps> = ({
  onCreate,
  onCancel,
}) => {
  const supportedVersions = window.pdv.system.supportedJuliaVersions;
  const [juliaVersion, setJuliaVersion] = useState(
    window.pdv.system.defaultJuliaVersion
  );
  const [packagesText, setPackagesText] = useState('');
  const [channels, setChannels] = useState<JuliaupChannel[]>([]);
  // null = presence not yet known (the filesystem check is in flight).
  const [juliaupInstalled, setJuliaupInstalled] = useState<boolean | null>(null);

  // Installed channels + juliaup presence are filesystem-only reads —
  // effectively instant, but the dialog renders usable defaults meanwhile.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pdv.environment.juliaupChannels(),
      window.pdv.environment.juliaupStatus(),
    ]).then(([chs, status]) => {
      if (cancelled) return;
      setChannels(chs);
      setJuliaupInstalled(status.installed);
      // Preselect the juliaup default channel's minor when it is supported —
      // the version the session would otherwise run.
      const defaultMinor = chs
        .filter((c) => c.isDefault && c.version !== null)
        .map((c) => minorOf(c.version!))
        .find((m) => m !== null && supportedVersions.includes(m));
      if (defaultMinor) setJuliaVersion(defaultMinor);
    });
    return () => {
      cancelled = true;
    };
    // supportedVersions is a preload-time constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The installed channel providing a supported minor, if any. */
  const installedFor = (minor: string): JuliaupChannel | undefined =>
    channels.find((c) => c.version !== null && minorOf(c.version) === minor);

  const handleCreate = () => {
    onCreate({
      // Without juliaup there is nothing to acquire or switch — the launch
      // falls back to the configured runtime (§10.6.5).
      juliaVersion: juliaupInstalled ? juliaVersion : undefined,
      packages: parsePackages(packagesText),
    });
  };

  const handleKeyDown = useModalKeyboard({ onSubmit: handleCreate, onCancel });

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="new-project-dialog"
        data-testid="new-julia-project-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3>New Julia Project</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            &times;
          </button>
        </div>

        <div className="dialog-body">
          {juliaupInstalled !== false ? (
            <>
              <label className="new-project-field">
                Julia version
                <select
                  value={juliaVersion}
                  onChange={(e) => setJuliaVersion(e.target.value)}
                  data-testid="new-julia-project-version"
                >
                  {supportedVersions.map((v) => {
                    const installed = installedFor(v);
                    return (
                      <option key={v} value={v}>
                        {installed
                          ? `${v} — installed (${installed.version})`
                          : `${v} — will be downloaded`}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div className="new-project-hint">
                Downloaded automatically with juliaup if not already installed.
              </div>
            </>
          ) : (
            <div className="new-project-hint" data-testid="new-julia-project-no-juliaup">
              juliaup (the Julia version manager) is not installed, so the
              project will use the configured Julia runtime. Settings →
              Runtime offers a one-click juliaup install.
            </div>
          )}

          <label className="new-project-field">
            Initial packages
            <input
              type="text"
              value={packagesText}
              onChange={(e) => setPackagesText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="DataFrames, CSV"
              data-testid="new-julia-project-packages"
            />
          </label>
          <div className="new-project-hint">
            Comma-separated; version pins welcome (e.g. <code>DataFrames@1.6</code>).
            More can be added later in Settings.
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            data-testid="new-julia-project-create"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
};
