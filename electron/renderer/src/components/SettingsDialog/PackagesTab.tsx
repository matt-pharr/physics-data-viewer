/**
 * PackagesTab — the "Project Environment" settings tab.
 *
 * Shows the active session's environment (mode badge, interpreter path,
 * Python version, via `environment.activeInfo`), and for uv-mode projects
 * lists declared dependencies from `pyproject.toml` paired with the version
 * actually installed in the venv (via `uv pip list`), with add / remove /
 * upgrade actions that go through `uv add` / `uv remove` /
 * `uv lock --upgrade-package` in the main process. Streams uv output via
 * the existing `envActivity` push channel.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §10.5.13 (Package Management UI), §10.5.19
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActiveEnvironmentInfo, EnvironmentInstallResult, ProjectPackage } from '../../types';

/** Props for {@link PackagesTab}. */
interface PackagesTabProps {
  /** Active environment mode. Only `'uv'` enables the package CRUD UI. */
  environmentMode?: 'uv' | 'shared' | 'pkg';
}

/** Settings tab body for the project environment (info header + packages). */
export const PackagesTab: React.FC<PackagesTabProps> = ({ environmentMode }) => {
  const [packages, setPackages] = useState<ProjectPackage[]>([]);
  const [envInfo, setEnvInfo] = useState<ActiveEnvironmentInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addInput, setAddInput] = useState('');
  const [output, setOutput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // Fetch the active session's environment metadata for the header.
  useEffect(() => {
    let cancelled = false;
    void window.pdv.environment.activeInfo().then((info) => {
      if (!cancelled) setEnvInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentMode]);

  // Auto-scroll the streaming output pane to the latest line.
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPackages(await window.pdv.environment.listPackages());
    } catch (err) {
      setErrorMsg(
        `Failed to list packages: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      setErrorMsg(null);
      try {
        const result = await op();
        if (!result.success) {
          // Streaming output usually shows uv's own error; make sure the
          // final output is there even if nothing streamed, and flag it.
          if (result.output) setOutput((prev) => prev || result.output);
          setErrorMsg('The uv command failed — see the output below.');
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
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

  // Environment info header shared by all modes (§10.5.19). Falls back to
  // the mode prop when the metadata fetch hasn't resolved yet.
  const mode = envInfo?.mode ?? environmentMode;
  const envHeader = (
    <div className="settings-env-header" data-testid="project-env-header">
      <span
        className={`settings-env-badge ${mode === 'uv' || mode === 'pkg' ? 'settings-env-badge-uv' : 'settings-env-badge-shared'}`}
      >
        {mode === 'uv'
          ? 'uv-managed · shareable'
          : mode === 'pkg'
            ? 'Pkg-managed · shareable'
            : 'external environment'}
      </span>
      {envInfo?.pythonVersion && (
        <span className="settings-env-version">Python {envInfo.pythonVersion}</span>
      )}
      {envInfo?.juliaVersion && (
        <span className="settings-env-version">Julia {envInfo.juliaVersion}</span>
      )}
      {envInfo?.interpreterPath && (
        <div className="settings-env-interpreter" title={envInfo.interpreterPath}>
          <code>{envInfo.interpreterPath}</code>
        </div>
      )}
    </div>
  );

  // pkg-mode Julia sessions (§10.6.8): the project environment is live and
  // travels with the save; package operations run in the kernel. The
  // uv-style CRUD list for Julia is a planned follow-up.
  if (environmentMode === 'pkg') {
    return (
      <div className="settings-packages">
        {envHeader}
        <p className="settings-packages-hint">
          This project owns a Pkg-managed Julia environment
          (<code>Project.toml</code> / <code>Manifest.toml</code>), saved with
          the project and instantiated automatically on open. Install packages
          with <code>PDVKernel.install(&quot;PackageName&quot;)</code> in a
          code cell (or <code>PDVKernel.remove</code> /{' '}
          <code>PDVKernel.update</code>) — they are recorded in the
          project&rsquo;s environment and travel with it.
        </p>
      </div>
    );
  }

  if (environmentMode !== 'uv') {
    return (
      <div className="settings-packages">
        {envHeader}
        <p className="settings-packages-hint">
          This project runs on an environment managed outside PDV (e.g. conda),
          chosen when the project was created. Use that environment&rsquo;s own
          package manager (pip / conda) to install packages. Changing an
          existing project&rsquo;s environment isn&rsquo;t supported yet
          (planned as a dedicated action).
        </p>
      </div>
    );
  }

  return (
    <div className="settings-packages">
      {envHeader}
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

      {errorMsg && <p className="error-text">{errorMsg}</p>}

      {output && (
        <pre className="env-install-output" ref={outputRef}>
          {output}
        </pre>
      )}
    </div>
  );
};
