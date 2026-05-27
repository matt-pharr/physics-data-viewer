/**
 * PackagesTab — Per-project dependency management for uv-mode projects.
 *
 * Lists declared dependencies from `pyproject.toml` paired with the version
 * actually installed in the venv (via `uv pip list`), and exposes add /
 * remove / upgrade actions that go through `uv add` / `uv remove` /
 * `uv lock --upgrade-package` in the main process. Streams uv output via
 * the existing `envActivity` push channel.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §10.5.13 (Package Management UI)
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EnvironmentInstallResult, ProjectPackage } from '../../types';

/** Props for {@link PackagesTab}. */
interface PackagesTabProps {
  /** Active environment mode. Only `'uv'` enables the package CRUD UI. */
  environmentMode?: 'uv' | 'shared';
}

/** Settings tab body for per-project package management. */
export const PackagesTab: React.FC<PackagesTabProps> = ({ environmentMode }) => {
  const [packages, setPackages] = useState<ProjectPackage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addInput, setAddInput] = useState('');
  const [output, setOutput] = useState('');
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-scroll the streaming output pane to the latest line.
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPackages(await window.pdv.environment.listPackages());
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh on mount/mode-change. The setState calls below are the canonical
  // "fetch async data on mount" pattern; the React-Compiler-leaning
  // `react-hooks/set-state-in-effect` rule flags it but there's no derived-
  // state alternative for a list that comes from an IPC round-trip.
  useEffect(() => {
    if (environmentMode === 'uv') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
    } else {
      setPackages([]);
    }
  }, [environmentMode, refresh]);

  // Always-on envActivity subscription accumulates uv output into the panel.
  // Clears at the start of each mutation so old output doesn't bleed forward.
  useEffect(() => {
    return window.pdv.environment.onEnvActivity((chunk) => {
      setOutput((prev) => prev + chunk.data);
    });
  }, []);

  const runMutation = useCallback(
    async (op: () => Promise<EnvironmentInstallResult>) => {
      setBusy(true);
      setOutput('');
      try {
        await op();
      } finally {
        // Re-list packages even on failure: uv may have partially applied.
        await refresh();
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleAdd = useCallback(() => {
    const spec = addInput.trim();
    if (!spec) return;
    setAddInput('');
    void runMutation(() => window.pdv.environment.addPackage([spec]));
  }, [addInput, runMutation]);

  if (environmentMode !== 'uv') {
    return (
      <div className="settings-packages">
        <p className="settings-packages-hint">
          Project package management is available only for uv-managed projects.
          This project uses the shared environment selected in the Runtime tab —
          use that environment&rsquo;s own package manager (pip / conda) to
          install packages.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-packages">
      <h4 className="settings-general-section">Project Dependencies</h4>
      <p className="settings-packages-hint">
        Packages declared in this project&rsquo;s <code>pyproject.toml</code>,
        with the version installed in the venv. Add, remove, and upgrade run
        through <code>uv</code> and update both <code>pyproject.toml</code> and{' '}
        <code>uv.lock</code>.
      </p>

      <div className="settings-packages-add">
        <input
          type="text"
          placeholder='package or PEP 508 spec (e.g. "numpy" or "scipy>=1.10")'
          value={addInput}
          onChange={(e) => setAddInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          disabled={busy}
        />
        <button
          className="btn btn-primary"
          onClick={handleAdd}
          disabled={busy || !addInput.trim()}
        >
          Add
        </button>
      </div>

      {loading && packages.length === 0 ? (
        <p className="settings-packages-hint">Loading…</p>
      ) : packages.length === 0 ? (
        <p className="settings-packages-hint">No declared dependencies.</p>
      ) : (
        <table className="settings-packages-table">
          <thead>
            <tr>
              <th>Spec</th>
              <th>Installed</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {packages.map((pkg) => (
              <tr key={pkg.spec}>
                <td>
                  <code>{pkg.spec}</code>
                </td>
                <td>{pkg.installedVersion ?? '—'}</td>
                <td className="settings-packages-actions">
                  <button
                    className="btn btn-secondary"
                    title="Upgrade to the latest compatible version"
                    disabled={busy}
                    onClick={() =>
                      void runMutation(() =>
                        window.pdv.environment.upgradePackage([pkg.name])
                      )
                    }
                  >
                    Upgrade
                  </button>
                  <button
                    className="btn btn-secondary"
                    title="Remove from pyproject.toml and the venv"
                    disabled={busy}
                    onClick={() =>
                      void runMutation(() =>
                        window.pdv.environment.removePackage([pkg.name])
                      )
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {output && (
        <pre className="env-install-output" ref={outputRef}>
          {output}
        </pre>
      )}
    </div>
  );
};
