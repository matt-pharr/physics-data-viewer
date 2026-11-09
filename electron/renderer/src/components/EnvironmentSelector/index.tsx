/**
 * EnvironmentSelector — Python/Julia environment discovery picker with
 * auto-install.
 *
 * In Python mode: discovers conda, venv, pyenv, and system Python environments,
 * shows package status badges, and offers one-click pdv-python installation from
 * the bundled source with streaming pip output.
 *
 * In Julia mode (§10.7): discovers juliaup channels (real versioned binaries,
 * never the shim) and system Julia installs, shows PDVKernel/IJulia status
 * badges, and offers one-click PDVKernel + IJulia installation into the
 * runtime's default environment with streaming Pkg output.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { pickServerPath } from '../../services/pick-path';
import type { EnvironmentInfo, InstallOutputChunk, JuliaRuntimeInfo } from '../../types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Imperative actions a host can drive when it owns the selector's buttons
 * (see `hideConfirm`/`hideInstallButton`). Exposed via the `actionsRef` prop.
 */
export interface EnvironmentSelectorActions {
  /**
   * Install pdv-python into the currently selected environment — same flow
   * as the inline install button (streaming output, post-install re-probe,
   * badge refresh). Resolves `true` on success.
   */
  installPdv: () => Promise<boolean>;
}

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
  /**
   * When true, the selector renders no confirm/cancel buttons of its own —
   * the host owns the single confirm (e.g. the New Project dialog's Create
   * button) and tracks the selection via `onSelectionChange`. Browse,
   * Refresh, and the pdv-python install panel stay available.
   */
  hideConfirm?: boolean;
  /**
   * When true, the pdv-python install panel renders its message and
   * streaming output but not its own install button — the host drives the
   * install through `actionsRef.installPdv()` (e.g. the New Project
   * dialog's footer button).
   */
  hideInstallButton?: boolean;
  /**
   * Receives the selector's imperative actions (install) so a host that
   * hides the inline buttons can drive them from its own chrome.
   */
  actionsRef?: React.MutableRefObject<EnvironmentSelectorActions | null>;
  /**
   * Fires whenever the highlighted environment changes (row click, browse,
   * refresh, post-install re-probe), with the freshest probe info — or null
   * when the selection is cleared. Lets a host with `hideConfirm` gate its
   * own confirm button on the selection's pdv status.
   */
  onSelectionChange?: (info: EnvironmentInfo | null) => void;
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
  juliaup: 'J',
};

const KIND_TOOLTIPS: Record<string, string> = {
  conda: 'Conda environment',
  venv: 'Virtual environment',
  pyenv: 'pyenv environment',
  system: 'System Python',
  configured: 'Manually configured',
  juliaup: 'juliaup channel',
};

const JULIA_KIND_TOOLTIPS: Record<string, string> = {
  juliaup: 'juliaup channel',
  system: 'System Julia',
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
  hideConfirm = false,
  hideInstallButton = false,
  actionsRef,
  onSelectionChange,
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

  // -- Julia discovery state (§10.7) -----------------------------------------
  const [juliaRuntimes, setJuliaRuntimes] = useState<JuliaRuntimeInfo[]>([]);
  const [juliaLoading, setJuliaLoading] = useState(true);
  const [juliaError, setJuliaError] = useState<string | null>(null);
  const [selectedJuliaPath, setSelectedJuliaPath] = useState<string | null>(null);
  const [selectedJuliaInfo, setSelectedJuliaInfo] = useState<JuliaRuntimeInfo | null>(null);
  const [juliaInstalling, setJuliaInstalling] = useState(false);
  const [juliaInstallOutput, setJuliaInstallOutput] = useState<string[]>([]);
  const [juliaInstallResult, setJuliaInstallResult] = useState<{ success: boolean; output: string } | null>(null);
  const juliaOutputRef = useRef<HTMLPreElement>(null);

  // -- juliaup version management state (§10.7.5) -----------------------------
  // null = presence not yet known (first scan in flight).
  const [juliaupInstalled, setJuliaupInstalled] = useState<boolean | null>(null);
  const [addVersionText, setAddVersionText] = useState('');
  const [addingVersion, setAddingVersion] = useState(false);
  const [addVersionOutput, setAddVersionOutput] = useState<string[]>([]);
  const [addVersionResult, setAddVersionResult] = useState<{ success: boolean; output: string } | null>(null);
  const addVersionOutputRef = useRef<HTMLPreElement>(null);
  const [installingJuliaup, setInstallingJuliaup] = useState(false);
  const [juliaupInstallOutput, setJuliaupInstallOutput] = useState<string[]>([]);
  const [juliaupInstallResult, setJuliaupInstallResult] = useState<{ success: boolean; output: string } | null>(null);
  const juliaupOutputRef = useRef<HTMLPreElement>(null);

  // The selector can unmount mid-flight (host dialog dismissed during a
  // discovery scan or a pdv-python install); async handlers must not set
  // state afterwards.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Surface every selection change (row click, browse, refresh clear,
  // post-install re-probe) to a host that owns the confirm button.
  useEffect(() => {
    onSelectionChange?.(selectedInfo);
    // `onSelectionChange` is intentionally omitted: hosts pass inline
    // closures, and re-firing on every parent render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInfo]);

  // -- Load environments on mount --------------------------------------------
  const loadEnvironments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const envs = await window.pdv.environment.list();
      if (!mountedRef.current) return null;
      setEnvironments(envs);
      return envs;
    } catch (err) {
      if (!mountedRef.current) return null;
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (mountedRef.current) setLoading(false);
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
      if (!mountedRef.current) return;
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
      if (!mountedRef.current) return;
      setEnvironments(envs);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // -- Install pdv-python ----------------------------------------------------
  const handleInstall = useCallback(async (): Promise<boolean> => {
    if (!selectedPath) return false;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);

    // Subscribe to streaming output
    const unsubscribe = window.pdv.environment.onInstallOutput((chunk: InstallOutputChunk) => {
      if (mountedRef.current) setInstallOutput((prev) => [...prev, chunk.data]);
    });

    try {
      const result = await window.pdv.environment.install(selectedPath);
      if (!mountedRef.current) return result.success;
      setInstallResult(result);

      if (result.success) {
        // Re-probe the environment to update badges
        const fresh = await window.pdv.environment.check(selectedPath);
        if (!mountedRef.current) return result.success;
        if (fresh) {
          setSelectedInfo(fresh);
          setEnvironments((prev) =>
            prev.map((e) => (e.pythonPath === fresh.pythonPath ? fresh : e))
          );
        }
      }
      return result.success;
    } catch (err) {
      if (mountedRef.current) {
        setInstallResult({
          success: false,
          output: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    } finally {
      unsubscribe();
      if (mountedRef.current) setInstalling(false);
    }
  }, [selectedPath]);

  // Hand the imperative actions to a host that owns the buttons.
  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current = { installPdv: handleInstall };
    return () => {
      actionsRef.current = null;
    };
  }, [actionsRef, handleInstall]);

  // Auto-scroll install output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [installOutput]);

  // -- Browse for executable -------------------------------------------------
  const handleBrowse = useCallback(async () => {
    try {
      const filePath = await pickServerPath({ mode: 'executable', title: 'Choose a Python interpreter' });
      if (!filePath) return;

      // Probe the selected path
      const info = await window.pdv.environment.check(filePath);
      if (!mountedRef.current) return;
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
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  // -- Confirm selection -----------------------------------------------------
  const handleConfirm = useCallback(() => {
    if (selectedPath && selectedInfo) {
      onSelect({ pythonPath: selectedPath });
    }
  }, [selectedPath, selectedInfo, onSelect]);

  // -- Julia discovery / selection (§10.7) ------------------------------------
  const loadJuliaRuntimes = useCallback(async () => {
    setJuliaLoading(true);
    setJuliaError(null);
    try {
      const [runtimes, juliaup] = await Promise.all([
        window.pdv.environment.listJulia(),
        window.pdv.environment.juliaupStatus(),
      ]);
      if (!mountedRef.current) return null;
      setJuliaRuntimes(runtimes);
      setJuliaupInstalled(juliaup.installed);
      return runtimes;
    } catch (err) {
      if (!mountedRef.current) return null;
      setJuliaError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (mountedRef.current) setJuliaLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeLanguage !== 'julia') return;
    void loadJuliaRuntimes().then((runtimes) => {
      if (!runtimes) return;
      // Auto-select the configured runtime, falling back to the juliaup
      // default channel on first run.
      const current =
        runtimes.find((r) => r.juliaPath === currentJuliaPath)
        ?? runtimes.find((r) => r.isDefault);
      if (current) {
        setSelectedJuliaPath(current.juliaPath);
        setSelectedJuliaInfo(current);
      }
    });
  // Only run on mount / language change — not when currentJuliaPath changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLanguage, loadJuliaRuntimes]);

  const handleJuliaSelect = useCallback(async (runtime: JuliaRuntimeInfo) => {
    setSelectedJuliaPath(runtime.juliaPath);
    setSelectedJuliaInfo(runtime);
    setJuliaInstallResult(null);
    setJuliaInstallOutput([]);

    // Re-probe for fresh PDVKernel/IJulia status.
    try {
      const fresh = await window.pdv.environment.checkJulia(runtime.juliaPath);
      if (!mountedRef.current) return;
      if (fresh) {
        setSelectedJuliaInfo(fresh);
        setJuliaRuntimes((prev) =>
          prev.map((r) => (r.juliaPath === fresh.juliaPath ? fresh : r))
        );
      }
    } catch {
      // Keep stale info on probe failure
    }
  }, []);

  const handleJuliaRefresh = useCallback(async () => {
    setSelectedJuliaPath(null);
    setSelectedJuliaInfo(null);
    await loadJuliaRuntimes();
  }, [loadJuliaRuntimes]);

  // Only one Julia install flow — PDVKernel install, `juliaup add`, or the
  // juliaup bootstrap — may run at a time: all three stream onto the single
  // onInstallOutput channel (their panes would interleave), and two
  // Pkg/juliaup subprocesses would mutate the same depot concurrently. A ref
  // (not state) so a double-click racing a re-render is still excluded; the
  // per-flow state flags drive the button labels/disabling.
  const juliaFlowBusyRef = useRef(false);

  const handleJuliaInstall = useCallback(async (): Promise<boolean> => {
    if (!selectedJuliaPath) return false;
    if (juliaFlowBusyRef.current) return false;
    juliaFlowBusyRef.current = true;
    setJuliaInstalling(true);
    setJuliaInstallOutput([]);
    setJuliaInstallResult(null);

    const unsubscribe = window.pdv.environment.onInstallOutput((chunk: InstallOutputChunk) => {
      if (mountedRef.current) setJuliaInstallOutput((prev) => [...prev, chunk.data]);
    });

    try {
      const result = await window.pdv.environment.installJulia(selectedJuliaPath);
      if (!mountedRef.current) return result.success;
      setJuliaInstallResult(result);

      if (result.success) {
        const fresh = await window.pdv.environment.checkJulia(selectedJuliaPath);
        if (!mountedRef.current) return result.success;
        if (fresh) {
          setSelectedJuliaInfo(fresh);
          setJuliaRuntimes((prev) =>
            prev.map((r) => (r.juliaPath === fresh.juliaPath ? fresh : r))
          );
        }
      }
      return result.success;
    } catch (err) {
      if (mountedRef.current) {
        setJuliaInstallResult({
          success: false,
          output: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    } finally {
      unsubscribe();
      juliaFlowBusyRef.current = false;
      if (mountedRef.current) setJuliaInstalling(false);
    }
  }, [selectedJuliaPath]);

  // Auto-scroll the Julia install output
  useEffect(() => {
    if (juliaOutputRef.current) {
      juliaOutputRef.current.scrollTop = juliaOutputRef.current.scrollHeight;
    }
  }, [juliaInstallOutput]);

  const handleJuliaBrowse = useCallback(async () => {
    try {
      const filePath = await pickServerPath({ mode: 'executable', title: 'Choose a Julia executable' });
      if (!filePath) return;
      const info = await window.pdv.environment.checkJulia(filePath);
      if (!mountedRef.current) return;
      if (info) {
        setSelectedJuliaPath(info.juliaPath);
        setSelectedJuliaInfo(info);
        setJuliaRuntimes((prev) => {
          if (prev.some((r) => r.juliaPath === info.juliaPath)) {
            return prev.map((r) => (r.juliaPath === info.juliaPath ? info : r));
          }
          return [info, ...prev];
        });
      } else {
        setJuliaError(`Could not detect a working Julia at: ${filePath}`);
      }
    } catch (err) {
      if (mountedRef.current) {
        setJuliaError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const handleJuliaConfirm = useCallback(() => {
    if (selectedJuliaPath && selectedJuliaInfo) {
      onSelect({ juliaPath: selectedJuliaPath });
    }
  }, [selectedJuliaPath, selectedJuliaInfo, onSelect]);

  // -- juliaup version management (§10.7.5) -----------------------------------

  const handleJuliaupAdd = useCallback(async () => {
    const channel = addVersionText.trim();
    if (!channel) return;
    if (juliaFlowBusyRef.current) return;
    juliaFlowBusyRef.current = true;
    setAddingVersion(true);
    setAddVersionOutput([]);
    setAddVersionResult(null);

    const unsubscribe = window.pdv.environment.onInstallOutput((chunk: InstallOutputChunk) => {
      if (mountedRef.current) setAddVersionOutput((prev) => [...prev, chunk.data]);
    });

    try {
      const result = await window.pdv.environment.juliaupAdd(channel);
      if (!mountedRef.current) return;
      setAddVersionResult(result);
      if (result.success) {
        setAddVersionText('');
        // The new channel appears in the discovery list; its default env
        // will need the one-click PDVKernel install (badges show that).
        await loadJuliaRuntimes();
      }
    } catch (err) {
      if (mountedRef.current) {
        setAddVersionResult({
          success: false,
          output: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      unsubscribe();
      juliaFlowBusyRef.current = false;
      if (mountedRef.current) setAddingVersion(false);
    }
  }, [addVersionText, loadJuliaRuntimes]);

  const handleInstallJuliaup = useCallback(async () => {
    if (juliaFlowBusyRef.current) return;
    juliaFlowBusyRef.current = true;
    setInstallingJuliaup(true);
    setJuliaupInstallOutput([]);
    setJuliaupInstallResult(null);

    const unsubscribe = window.pdv.environment.onInstallOutput((chunk: InstallOutputChunk) => {
      if (mountedRef.current) setJuliaupInstallOutput((prev) => [...prev, chunk.data]);
    });

    try {
      const result = await window.pdv.environment.installJuliaup();
      if (!mountedRef.current) return;
      setJuliaupInstallResult(result);
      if (result.success) {
        // The installer also installs a default Julia — rescan picks up
        // both juliaup presence and the new channel.
        await loadJuliaRuntimes();
      }
    } catch (err) {
      if (mountedRef.current) {
        setJuliaupInstallResult({
          success: false,
          output: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      unsubscribe();
      juliaFlowBusyRef.current = false;
      if (mountedRef.current) setInstallingJuliaup(false);
    }
  }, [loadJuliaRuntimes]);

  // Auto-scroll the juliaup streaming panes
  useEffect(() => {
    if (addVersionOutputRef.current) {
      addVersionOutputRef.current.scrollTop = addVersionOutputRef.current.scrollHeight;
    }
  }, [addVersionOutput]);
  useEffect(() => {
    if (juliaupOutputRef.current) {
      juliaupOutputRef.current.scrollTop = juliaupOutputRef.current.scrollHeight;
    }
  }, [juliaupInstallOutput]);

  // -- Can the user confirm selection? ---------------------------------------
  // Free-threaded (no-GIL) Python builds cannot run a PDV kernel because
  // pyzmq's C extension is not yet free-thread-safe. Block selection of
  // such environments and explain rather than silently failing later.
  const canConfirm =
    selectedInfo?.pdvInstalled
    && selectedInfo?.pdvCompatible
    && !selectedInfo?.isFreeThreaded;

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
              {env.isFreeThreaded && (
                <span
                  className="env-badge env-badge--missing"
                  title="Free-threaded (no-GIL) Python — not supported by PDV. pyzmq, jupyter_client, and ipykernel are not yet free-thread-safe."
                >
                  no-GIL
                </span>
              )}
              {env.pdvInstalled ? (
                env.pdvVersionMismatch ? (
                  <span className="env-badge env-badge--warning" title={`Version mismatch: ${env.pdvVersion} (app: ${appVersion ?? '?'})`}>pdv {env.pdvVersion}</span>
                ) : (
                  <span className="env-badge env-badge--ok" title={`pdv-python ${env.pdvVersion}`}>pdv {env.pdvVersion}</span>
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

      {/* Free-threaded Python is unsupported — block install/confirm and explain. */}
      {selectedInfo?.isFreeThreaded && (
        <div className="env-install-panel">
          <div className="env-install-header">
            This is a free-threaded (no-GIL) Python build. PDV cannot run on
            it — pyzmq, jupyter_client, and ipykernel are not yet
            free-thread-safe. Select a standard (GIL-enabled) Python 3.10–3.14
            instead. If this conda env is named &lt;name&gt;t (e.g. "314t"),
            create a non-free-threaded one with{' '}
            <code>conda create -n &lt;name&gt; python=3.14</code>.
          </div>
        </div>
      )}

      {/* Install panel — visible when selected env needs pdv-python (and is not free-threaded). */}
      {selectedInfo && !selectedInfo.isFreeThreaded && (!selectedInfo.pdvInstalled || selectedInfo.pdvVersionMismatch) && (
        <div className="env-install-panel">
          <div className="env-install-header">
            {selectedInfo.pdvVersionMismatch
              ? `pdv-python ${selectedInfo.pdvVersion} installed — v${appVersion ?? 'latest'} required.`
              : 'pdv-python is not installed in this environment.'}
          </div>
          {!hideInstallButton && (
            <button
              className="btn btn-primary"
              onClick={() => void handleInstall()}
              disabled={installing}
              type="button"
            >
              {installing
                ? 'Installing...'
                : selectedInfo.pdvVersionMismatch
                  ? `Install pdv-python ${appVersion ?? 'latest'}`
                  : 'Install pdv-python'}
            </button>
          )}

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

      {/* Confirm / Cancel — suppressed when the host owns the confirm
          (e.g. the New Project dialog's single Create button). */}
      {!hideConfirm && (
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
      )}
    </>
  );

  // A runtime is launchable once PDVKernel (compatible) and IJulia resolve.
  const canConfirmJulia =
    selectedJuliaInfo?.pdvKernelInstalled
    && selectedJuliaInfo?.pdvKernelCompatible
    && selectedJuliaInfo?.ijuliaInstalled;

  const juliaNeedsInstall =
    selectedJuliaInfo
    && (!selectedJuliaInfo.pdvKernelInstalled
      || selectedJuliaInfo.pdvKernelVersionMismatch
      || !selectedJuliaInfo.ijuliaInstalled);

  const juliaContent = (
    <>
      <h2>Select Julia Runtime</h2>

      {warning && (
        <p className="error-text">{warning}</p>
      )}

      {isFirstRun && (
        <p className="help-text">
          PDV needs a Julia runtime with the PDVKernel package to run. Select
          one below and we'll install everything automatically.
        </p>
      )}

      {/* Runtime list */}
      <div className="env-list">
        {juliaLoading && <div className="env-list-loading">Detecting Julia runtimes...</div>}

        {!juliaLoading && juliaError && <div className="error-text">{juliaError}</div>}

        {!juliaLoading && !juliaError && juliaRuntimes.length === 0 && (
          <div className="env-list-empty">
            {juliaupInstalled === false
              ? 'No Julia runtimes found. Use "Install juliaup" below to set everything up automatically, or Browse to locate a Julia executable.'
              : 'No Julia runtimes found. Add a version below with juliaup, or use Browse to locate a Julia executable.'}
          </div>
        )}

        {!juliaLoading && juliaRuntimes.map((runtime) => (
          <button
            key={runtime.juliaPath}
            className={`env-row ${selectedJuliaPath === runtime.juliaPath ? 'env-row--selected' : ''}`}
            onClick={() => void handleJuliaSelect(runtime)}
            type="button"
          >
            <span className={`env-kind-badge env-kind-badge--${runtime.kind}`} title={JULIA_KIND_TOOLTIPS[runtime.kind] ?? 'Unknown'}>
              {KIND_ICONS[runtime.kind] ?? '?'}
            </span>
            <span className="env-row-info">
              <span className="env-row-label">{runtime.label}</span>
              <span className="env-row-path">{runtime.juliaPath}</span>
            </span>
            <span className="env-row-badges">
              {runtime.pdvKernelInstalled ? (
                runtime.pdvKernelVersionMismatch ? (
                  <span className="env-badge env-badge--warning" title={`Version mismatch: ${runtime.pdvKernelVersion} (app: ${appVersion ?? '?'})`}>PDVKernel {runtime.pdvKernelVersion}</span>
                ) : (
                  <span className="env-badge env-badge--ok" title={`PDVKernel ${runtime.pdvKernelVersion}`}>PDVKernel {runtime.pdvKernelVersion}</span>
                )
              ) : (
                <span className="env-badge env-badge--missing" title="PDVKernel not installed">PDVKernel</span>
              )}
              {runtime.ijuliaInstalled ? (
                <span className="env-badge env-badge--ok" title="IJulia installed">IJulia</span>
              ) : (
                <span className="env-badge env-badge--missing" title="IJulia not installed">IJulia</span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* Action bar: Browse + Refresh */}
      <div className="env-actions">
        <button className="btn btn-secondary" onClick={handleJuliaBrowse} type="button">
          Browse...
        </button>
        <button className="btn btn-secondary" onClick={() => void handleJuliaRefresh()} disabled={juliaLoading} type="button">
          {juliaLoading ? 'Scanning...' : 'Refresh'}
        </button>
      </div>

      {/* juliaup bootstrap — offered when juliaup is absent (§10.7.5). */}
      {juliaupInstalled === false && (
        <div className="env-install-panel">
          <div className="env-install-header">
            juliaup (the Julia version manager) is not installed. PDV uses it
            to install and switch Julia versions; installing it also installs
            the latest Julia.
          </div>
          <button
            className="btn btn-primary"
            onClick={() => void handleInstallJuliaup()}
            disabled={installingJuliaup || addingVersion || juliaInstalling}
            type="button"
          >
            {installingJuliaup
              ? 'Installing juliaup... (this can take a few minutes)'
              : 'Install juliaup'}
          </button>
          {(juliaupInstallOutput.length > 0 || juliaupInstallResult) && (
            <pre className="env-install-output" ref={juliaupOutputRef}>
              {juliaupInstallOutput.length > 0
                ? juliaupInstallOutput.join('')
                : juliaupInstallResult?.output ?? ''}
            </pre>
          )}
          {juliaupInstallResult && (
            <div className={juliaupInstallResult.success ? 'env-install-success' : 'error-text'}>
              {juliaupInstallResult.success
                ? 'juliaup installed.'
                : 'juliaup installation failed.'}
            </div>
          )}
        </div>
      )}

      {/* Version acquisition — `juliaup add <channel>` (§10.7.5). */}
      {juliaupInstalled === true && (
        <div className="env-add-version">
          <input
            type="text"
            placeholder='Add a Julia version with juliaup (e.g. "1.10", "lts", "rc")'
            value={addVersionText}
            onChange={(e) => setAddVersionText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleJuliaupAdd();
            }}
            disabled={addingVersion || juliaInstalling || installingJuliaup}
          />
          <button
            className="btn btn-secondary"
            onClick={() => void handleJuliaupAdd()}
            disabled={addingVersion || juliaInstalling || installingJuliaup || !addVersionText.trim()}
            type="button"
          >
            {addingVersion ? 'Adding...' : 'Add'}
          </button>
        </div>
      )}
      {(addVersionOutput.length > 0 || addVersionResult) && (
        <>
          <pre className="env-install-output" ref={addVersionOutputRef}>
            {addVersionOutput.length > 0
              ? addVersionOutput.join('')
              : addVersionResult?.output ?? ''}
          </pre>
          {addVersionResult && (
            <div className={addVersionResult.success ? 'env-install-success' : 'error-text'}>
              {addVersionResult.success
                ? 'Julia version installed — select its channel above and install PDVKernel into it.'
                : 'juliaup add failed.'}
            </div>
          )}
        </>
      )}

      {/* Install panel — visible when the selected runtime needs PDVKernel/IJulia. */}
      {juliaNeedsInstall && (
        <div className="env-install-panel">
          <div className="env-install-header">
            {selectedJuliaInfo.pdvKernelVersionMismatch
              ? `PDVKernel ${selectedJuliaInfo.pdvKernelVersion} installed — v${appVersion ?? 'latest'} required.`
              : !selectedJuliaInfo.pdvKernelInstalled
                ? 'PDVKernel is not installed in this runtime’s default environment.'
                : 'IJulia is not installed in this runtime’s default environment.'}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => void handleJuliaInstall()}
            disabled={juliaInstalling || addingVersion || installingJuliaup}
            type="button"
          >
            {juliaInstalling
              ? 'Installing... (first install can take a few minutes)'
              : selectedJuliaInfo.pdvKernelVersionMismatch
                ? `Install PDVKernel ${appVersion ?? 'latest'}`
                : 'Install PDVKernel'}
          </button>

          {/* Streaming Pkg output */}
          {(juliaInstallOutput.length > 0 || juliaInstallResult) && (
            <pre className="env-install-output" ref={juliaOutputRef}>
              {juliaInstallOutput.length > 0
                ? juliaInstallOutput.join('')
                : juliaInstallResult?.output ?? ''}
            </pre>
          )}

          {/* Result message */}
          {juliaInstallResult && (
            <div className={juliaInstallResult.success ? 'env-install-success' : 'error-text'}>
              {juliaInstallResult.success
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
          onClick={handleJuliaConfirm}
          disabled={!canConfirmJulia}
          type="button"
          title={canConfirmJulia ? undefined : 'Install PDVKernel first'}
        >
          Select Runtime
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

  // Escape dismisses the modal variant when cancelling is allowed. Embedded
  // hosts (Settings, New Project dialog) own their own keyboard handling.
  useEffect(() => {
    if (embedded || isFirstRun || !onCancel) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [embedded, isFirstRun, onCancel]);

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
