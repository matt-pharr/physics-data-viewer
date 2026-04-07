/**
 * EnvironmentSelector — Python environment discovery picker with auto-install.
 *
 * In Python mode: discovers conda, venv, pyenv, and system Python environments,
 * shows package status badges, and offers one-click pdv-python installation from
 * the bundled source with streaming pip output.
 *
 * In Julia mode: shows a stub with manual path input (discovery not yet implemented).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvironmentInfo, InstallOutputChunk } from '../../types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EnvironmentSelectorProps {
  /** True when no interpreter has been configured yet. */
  isFirstRun: boolean;
  /** Which language runtime the picker should target. */
  activeLanguage: 'python' | 'julia';
  /** Currently configured Python path (to highlight in the list). */
  currentPythonPath?: string;
  /** Currently configured Julia path (for the Julia stub input). */
  currentJuliaPath?: string;
  /** Warning message to display (e.g. when a saved interpreter is unavailable). */
  warning?: string | null;
  /** When true, renders inline (no modal overlay). Used in Settings → Runtime. */
  embedded?: boolean;
  /** Called when the user selects an environment. */
  onSelect: (config: { pythonPath?: string; juliaPath?: string }) => void;
  /** Called when the user cancels (not shown on first run). */
  onCancel?: () => void;
}

// ---------------------------------------------------------------------------
// Kind icons (text-based, no emoji)
// ---------------------------------------------------------------------------

const KIND_ICONS: Record<string, string> = {
  conda: 'C',
  venv: 'V',
  pyenv: 'P',
  system: 'S',
  configured: '*',
};

const KIND_TOOLTIPS: Record<string, string> = {
  conda: 'Conda environment',
  venv: 'Virtual environment',
  pyenv: 'pyenv environment',
  system: 'System Python',
  configured: 'Manually configured',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const EnvironmentSelector: React.FC<EnvironmentSelectorProps> = ({
  isFirstRun,
  activeLanguage,
  currentPythonPath,
  currentJuliaPath,
  warning,
  embedded = false,
  onSelect,
  onCancel,
}) => {
  // -- App version (unified — same as bundled pdv-python version) -----------
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void window.pdv.about.getVersion().then(setAppVersion);
  }, []);

  // -- Python discovery state ------------------------------------------------
  const [environments, setEnvironments] = useState<EnvironmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedInfo, setSelectedInfo] = useState<EnvironmentInfo | null>(null);

  // -- Install state ---------------------------------------------------------
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ success: boolean; output: string } | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // -- Julia stub state ------------------------------------------------------
  const [juliaPath, setJuliaPath] = useState(currentJuliaPath || 'julia');

  // -- Load environments on mount --------------------------------------------
  const loadEnvironments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const envs = await window.pdv.environment.list();
      setEnvironments(envs);
      return envs;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeLanguage !== 'python') return;
    void loadEnvironments().then((envs) => {
      if (!envs) return;
      // Auto-select the currently configured environment on first load.
      const current = envs.find((e) => e.pythonPath === currentPythonPath);
      if (current) {
        setSelectedPath(current.pythonPath);
        setSelectedInfo(current);
      }
    });
  // Only run on mount / language change — not when currentPythonPath changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLanguage, loadEnvironments]);

  // -- Select an environment -------------------------------------------------
  const handleSelect = useCallback(async (env: EnvironmentInfo) => {
    setSelectedPath(env.pythonPath);
    setSelectedInfo(env);
    setInstallResult(null);
    setInstallOutput([]);

    // Re-probe to get fresh status
    try {
      const fresh = await window.pdv.environment.check(env.pythonPath);
      if (fresh) {
        setSelectedInfo(fresh);
        // Update the environment in the list too
        setEnvironments((prev) =>
          prev.map((e) => (e.pythonPath === fresh.pythonPath ? fresh : e))
        );
      }
    } catch {
      // Keep stale info on probe failure
    }
  }, []);

  // -- Refresh environments --------------------------------------------------
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedPath(null);
    setSelectedInfo(null);
    try {
      const envs = await window.pdv.environment.refresh();
      setEnvironments(envs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // -- Install pdv-python ----------------------------------------------------
  const handleInstall = useCallback(async () => {
    if (!selectedPath) return;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);

    // Subscribe to streaming output
    const unsubscribe = window.pdv.environment.onInstallOutput((chunk: InstallOutputChunk) => {
      setInstallOutput((prev) => [...prev, chunk.data]);
    });

    try {
      const result = await window.pdv.environment.install(selectedPath);
      setInstallResult(result);

      if (result.success) {
        // Re-probe the environment to update badges
        const fresh = await window.pdv.environment.check(selectedPath);
        if (fresh) {
          setSelectedInfo(fresh);
          setEnvironments((prev) =>
            prev.map((e) => (e.pythonPath === fresh.pythonPath ? fresh : e))
          );
        }
      }
    } catch (err) {
      setInstallResult({
        success: false,
        output: err instanceof Error ? err.message : String(err),
      });
    } finally {
      unsubscribe();
      setInstalling(false);
    }
  }, [selectedPath]);

  // Auto-scroll install output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [installOutput]);

  // -- Browse for executable -------------------------------------------------
  const handleBrowse = useCallback(async () => {
    try {
      const filePath = await window.pdv.files.pickExecutable();
      if (!filePath) return;

      // Probe the selected path
      const info = await window.pdv.environment.check(filePath);
      if (info) {
        setSelectedPath(info.pythonPath);
        setSelectedInfo(info);
        // Add to list if not already there
        setEnvironments((prev) => {
          if (prev.some((e) => e.pythonPath === info.pythonPath)) {
            return prev.map((e) => (e.pythonPath === info.pythonPath ? info : e));
          }
          return [info, ...prev];
        });
      } else {
        setError(`Could not detect a valid Python at: ${filePath}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // -- Confirm selection -----------------------------------------------------
  const handleConfirm = useCallback(() => {
    if (selectedPath && selectedInfo) {
      onSelect({ pythonPath: selectedPath });
    }
  }, [selectedPath, selectedInfo, onSelect]);

  // -- Julia browse ----------------------------------------------------------
  const handleJuliaBrowse = useCallback(async () => {
    try {
      const filePath = await window.pdv.files.pickExecutable();
      if (filePath) setJuliaPath(filePath);
    } catch { /* ignore */ }
  }, []);

  const handleJuliaConfirm = useCallback(() => {
    onSelect({ juliaPath });
  }, [juliaPath, onSelect]);

  // -- Can the user confirm selection? ---------------------------------------
  const canConfirm = selectedInfo?.pdvInstalled && selectedInfo?.pdvCompatible;

  // -- Render ----------------------------------------------------------------

  const pythonContent = (
    <>
      <h2>Select Python Environment</h2>

      {warning && (
        <p className="error-text">{warning}</p>
      )}

      {isFirstRun && (
        <p className="help-text">
          PDV needs a Python environment with ipykernel to run. Select one below
          and we'll install everything automatically.
        </p>
      )}

      {/* Environment list */}
      <div className="env-list">
        {loading && <div className="env-list-loading">Detecting Python environments...</div>}

        {!loading && error && <div className="error-text">{error}</div>}

        {!loading && !error && environments.length === 0 && (
          <div className="env-list-empty">
            No Python environments found. Use Browse to locate a Python executable.
          </div>
        )}

        {!loading && environments.map((env) => (
          <button
            key={env.pythonPath}
            className={`env-row ${selectedPath === env.pythonPath ? 'env-row--selected' : ''}`}
            onClick={() => handleSelect(env)}
            type="button"
          >
            <span className={`env-kind-badge env-kind-badge--${env.kind}`} title={KIND_TOOLTIPS[env.kind] ?? 'Unknown'}>
              {KIND_ICONS[env.kind] ?? '?'}
            </span>
            <span className="env-row-info">
              <span className="env-row-label">{env.label}</span>
              <span className="env-row-path">{env.pythonPath}</span>
            </span>
            <span className="env-row-badges">
              {env.pdvInstalled ? (
                env.pdvVersionMismatch ? (
                  <span className="env-badge env-badge--warning" title={`Version mismatch: ${env.pdvVersion} (app: ${appVersion ?? '?'})`}>pdv {env.pdvVersion}</span>
                ) : (
                  <span className="env-badge env-badge--ok" title={`pdv-python ${env.pdvVersion}`}>pdv</span>
                )
              ) : (
                <span className="env-badge env-badge--missing" title="pdv-python not installed">pdv</span>
              )}
              {env.ipykernelInstalled ? (
                <span className="env-badge env-badge--ok" title="ipykernel installed">ipy</span>
              ) : (
                <span className="env-badge env-badge--missing" title="ipykernel not installed">ipy</span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* Action bar: Browse + Refresh */}
      <div className="env-actions">
        <button className="btn btn-secondary" onClick={handleBrowse} type="button">
          Browse...
        </button>
        <button className="btn btn-secondary" onClick={handleRefresh} disabled={loading} type="button">
          {loading ? 'Scanning...' : 'Refresh'}
        </button>
      </div>

      {/* Install panel — visible when selected env needs pdv-python */}
      {selectedInfo && (!selectedInfo.pdvInstalled || selectedInfo.pdvVersionMismatch) && (
        <div className="env-install-panel">
          <div className="env-install-header">
            {selectedInfo.pdvVersionMismatch
              ? `pdv-python ${selectedInfo.pdvVersion} installed — v${appVersion ?? 'latest'} required.`
              : 'pdv-python is not installed in this environment.'}
          </div>
          <button
            className="btn btn-primary"
            onClick={handleInstall}
            disabled={installing}
            type="button"
          >
            {installing
              ? 'Installing...'
              : selectedInfo.pdvVersionMismatch
                ? `Install pdv-python ${appVersion ?? 'latest'}`
                : 'Install pdv-python'}
          </button>

          {/* Streaming output */}
          {(installOutput.length > 0 || installResult) && (
            <pre className="env-install-output" ref={outputRef}>
              {installOutput.length > 0
                ? installOutput.join('')
                : installResult?.output ?? ''}
            </pre>
          )}

          {/* Result message */}
          {installResult && (
            <div className={installResult.success ? 'env-install-success' : 'error-text'}>
              {installResult.success
                ? 'Installation complete.'
                : 'Installation failed.'}
            </div>
          )}
        </div>
      )}

      {/* Confirm / Cancel */}
      <div className="button-group">
        <button
          className="btn btn-primary"
          onClick={handleConfirm}
          disabled={!canConfirm}
          type="button"
          title={canConfirm ? undefined : 'Install pdv-python first'}
        >
          Select Environment
        </button>
        {!isFirstRun && onCancel && (
          <button className="btn btn-secondary" onClick={onCancel} type="button">
            Cancel
          </button>
        )}
      </div>
    </>
  );

  const juliaContent = (
    <>
      <h2>Configure Julia Runtime</h2>
      <p className="help-text">
        Julia environment discovery is not yet available. Enter a Julia executable path below.
      </p>
      <div className="input-group">
        <label>Julia Executable</label>
        <div className="input-with-button">
          <input
            type="text"
            value={juliaPath}
            onChange={(e) => setJuliaPath(e.target.value)}
            placeholder="/usr/local/bin/julia"
          />
          <button className="btn btn-secondary" onClick={handleJuliaBrowse} type="button">
            Browse
          </button>
        </div>
      </div>
      <div className="button-group">
        <button className="btn btn-primary" onClick={handleJuliaConfirm} type="button">
          Save
        </button>
        {!isFirstRun && onCancel && (
          <button className="btn btn-secondary" onClick={onCancel} type="button">
            Cancel
          </button>
        )}
      </div>
    </>
  );

  const content = activeLanguage === 'python' ? pythonContent : juliaContent;

  if (embedded) {
    return <div className="environment-selector-embedded">{content}</div>;
  }

  return (
    <div className="modal-overlay">
      <div className="environment-selector">
        {content}
      </div>
    </div>
  );
};
