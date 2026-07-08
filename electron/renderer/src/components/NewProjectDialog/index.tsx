/**
 * NewProjectDialog — creation-time environment setup for a new Python project.
 *
 * Shown when the user clicks "New Python Project" on the welcome screen.
 * Two mutually exclusive modes with a single Create button in the footer:
 *
 * - **uv-managed** (default): Python version (from the supported range) and
 *   the initial package list (prefilled from the user's default packages).
 * - **existing environment** (behind the "Advanced" toggle): run on a
 *   conda/system interpreter instead. Opening it hides the uv fields — the
 *   two paths can't be half-selected — and the footer's primary button is
 *   the single action, always visible: **Create** when the highlighted
 *   environment can run PDV, **Install pdv-python** when that is the
 *   required next step (driving the selector's install flow via
 *   `actionsRef`), and disabled-with-reason otherwise. The embedded
 *   selector's own confirm/install buttons are suppressed.
 *
 * The project itself stays unsaved until the first explicit Save; this
 * dialog configures only the environment.
 *
 * Follows the standard modal-overlay pattern (SaveAsDialog, CreateScriptDialog).
 */

import React, { useRef, useState } from 'react';
import type { EnvironmentInfo } from '../../types';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';
import {
  EnvironmentSelector,
  type EnvironmentSelectorActions,
} from '../EnvironmentSelector';

interface NewProjectDialogProps {
  /** Packages prefilled into the packages field (the user's defaults). */
  defaultPackages: string[];
  /** Currently configured Python path (highlighted in the advanced selector). */
  currentPythonPath?: string;
  /** Create a uv-managed project with the chosen version and packages. */
  onCreateUv: (opts: { pythonVersion: string; packages: string[] }) => void;
  /** Create a project on an existing (conda/system) interpreter. */
  onCreateShared: (pythonPath: string) => void;
  /** Called when the user cancels (Escape, ×, backdrop, Cancel). */
  onCancel: () => void;
}

/** Split a comma/whitespace-separated package string into PEP 508 specs. */
function parsePackages(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const NewProjectDialog: React.FC<NewProjectDialogProps> = ({
  defaultPackages,
  currentPythonPath,
  onCreateUv,
  onCreateShared,
  onCancel,
}) => {
  const supportedVersions = window.pdv.system.supportedPythonVersions;
  const [pythonVersion, setPythonVersion] = useState(
    window.pdv.system.defaultPythonVersion
  );
  const [packagesText, setPackagesText] = useState(defaultPackages.join(', '));
  const [mode, setMode] = useState<'uv' | 'existing'>('uv');
  const [selectedEnv, setSelectedEnv] = useState<EnvironmentInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const selectorActions = useRef<EnvironmentSelectorActions | null>(null);

  // Mirrors the environment selector's own confirm gate: the chosen
  // interpreter must have a compatible pdv-python and not be free-threaded.
  const envUsable =
    !!selectedEnv?.pdvInstalled &&
    !!selectedEnv?.pdvCompatible &&
    !selectedEnv?.isFreeThreaded;

  // A selected env that merely lacks (or has the wrong) pdv-python is one
  // click away from usable — the footer's primary button becomes the install
  // action so the required next step is never hidden behind a scroll.
  const needsInstall =
    !!selectedEnv &&
    !selectedEnv.isFreeThreaded &&
    (!selectedEnv.pdvInstalled || !!selectedEnv.pdvVersionMismatch || !selectedEnv.pdvCompatible);

  const canCreate = mode === 'uv' || envUsable;
  const disabledReason = !selectedEnv
    ? 'Select an environment from the list first'
    : selectedEnv.isFreeThreaded
      ? 'Free-threaded (no-GIL) Python builds cannot run PDV'
      : 'Install pdv-python into the selected environment first';

  const handleCreate = () => {
    if (mode === 'existing') {
      if (envUsable && selectedEnv) onCreateShared(selectedEnv.pythonPath);
      return;
    }
    onCreateUv({ pythonVersion, packages: parsePackages(packagesText) });
  };

  // Footer install action: drives the selector's install flow (streaming
  // output, post-install re-probe). On success the re-probe flips the
  // selection to usable and this button becomes Create.
  const handleInstall = async () => {
    if (!selectorActions.current) return;
    setInstalling(true);
    try {
      await selectorActions.current.installPdv();
    } finally {
      setInstalling(false);
    }
  };

  const handleKeyDown = useModalKeyboard({ onSubmit: handleCreate, onCancel });

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="new-project-dialog"
        data-testid="new-project-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3>New Python Project</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            &times;
          </button>
        </div>

        <div className="dialog-body">
          {mode === 'uv' && (
            <>
              <label className="new-project-field">
                Python version
                <select
                  value={pythonVersion}
                  onChange={(e) => setPythonVersion(e.target.value)}
                  data-testid="new-project-python-version"
                >
                  {supportedVersions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <div className="new-project-hint">
                Downloaded automatically if not already installed.
              </div>

              <label className="new-project-field">
                Initial packages
                <input
                  type="text"
                  value={packagesText}
                  onChange={(e) => setPackagesText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="numpy, matplotlib"
                  data-testid="new-project-packages"
                />
              </label>
              <div className="new-project-hint">
                Comma-separated; version specifiers welcome (e.g. <code>scipy&gt;=1.10</code>).
                More can be added later in Settings.
              </div>
            </>
          )}

          <button
            type="button"
            className="new-project-advanced-toggle"
            onClick={() => {
              setMode((m) => (m === 'uv' ? 'existing' : 'uv'));
            }}
            data-testid="new-project-advanced-toggle"
            aria-expanded={mode === 'existing'}
          >
            {mode === 'existing'
              ? '▾ Using an existing environment — click to switch back to a PDV-managed project'
              : '▸ Advanced: use an existing environment'}
          </button>

          {mode === 'existing' && (
            <div className="new-project-advanced">
              <div className="new-project-hint">
                Run this project on an environment you manage yourself (e.g. a
                conda env with cluster-specific libraries). The project will
                not be self-contained or shareable — the environment must
                exist wherever the project is opened. Select an environment
                below, then press Create.
              </div>
              <EnvironmentSelector
                isFirstRun={false}
                activeLanguage="python"
                currentPythonPath={currentPythonPath}
                embedded
                hideConfirm
                hideInstallButton
                actionsRef={selectorActions}
                onSelectionChange={setSelectedEnv}
                onSelect={() => undefined}
              />
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel} disabled={installing}>
            Cancel
          </button>
          {mode === 'existing' && needsInstall ? (
            <button
              className="btn btn-primary"
              onClick={() => void handleInstall()}
              disabled={installing}
              data-testid="new-project-install-pdv"
            >
              {installing ? 'Installing…' : 'Install pdv-python'}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              disabled={!canCreate}
              title={canCreate ? undefined : disabledReason}
              data-testid="new-project-create"
            >
              {mode === 'existing' ? 'Create with Selected Environment' : 'Create'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
