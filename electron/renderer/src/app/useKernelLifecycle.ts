import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Config, LogEntry } from '../types';
import { invalidateAllKernelState } from '../queries/invalidation';

type KernelStatus = 'idle' | 'starting' | 'ready' | 'error';

/** Options for {@link useKernelLifecycle}. All setters correspond to App-level useState. */
interface UseKernelLifecycleOptions {
  /** Current app configuration (pythonPath, kernelSpec, etc.). */
  config: Config | null;
  /** ID of the currently running kernel, or null if none is running. */
  currentKernelId: string | null;
  /** Setter for the active kernel ID (null on stop/crash). */
  setCurrentKernelId: Dispatch<SetStateAction<string | null>>;
  /** Setter for the kernel connection status shown in the status bar. */
  setKernelStatus: Dispatch<SetStateAction<KernelStatus>>;
  /** Setter for the most recent error message (clears on successful start). */
  setLastError: Dispatch<SetStateAction<string | undefined>>;
  /** Updates the persisted app configuration after environment changes. */
  setConfig: Dispatch<SetStateAction<Config | null>>;
  /** Clears the console log entries on kernel restart. */
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  /** Setter for the active environment mode ("uv" project venv vs shared). */
  setEnvironmentMode: Dispatch<SetStateAction<'uv' | 'shared' | 'pkg'>>;
}

export function useKernelLifecycle(options: UseKernelLifecycleOptions) {
  const {
    config,
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setConfig,
    setLogs,
    setEnvironmentMode,
  } = options;

  // Serializes startKernel calls so only one runs at a time.
  // A second call while one is in-flight queues and replaces any
  // previously queued call (only the latest queued call runs).
  const startQueueRef = useRef<Promise<boolean>>(Promise.resolve(false));
  const pendingStartRef = useRef<{ cfg: Config; language: 'python' | 'julia'; uvContext?: import('../types').KernelUvContext; resolve: (v: boolean) => void } | null>(null);
  // Mirrors `lastError` synchronously so callers can read the message right
  // after `await startKernel()` returns, without waiting for React to flush
  // setLastError. Used to surface diagnostic text (e.g. handshake-step errors)
  // in the env-settings dialog warning slot.
  const lastErrorRef = useRef<string | undefined>(undefined);

  const doStartKernel = useCallback(async (cfg: Config, language: 'python' | 'julia' = 'python', uvContext?: import('../types').KernelUvContext): Promise<boolean> => {
    setKernelStatus('starting');
    setLastError(undefined);
    lastErrorRef.current = undefined;
    try {
      if (currentKernelId) {
        await window.pdv.kernels.stop(currentKernelId);
        // Drop the dead kernel's cached queries outright — no refetch storm
        // for a kernel that no longer exists. The new kernel's queries start
        // cold and fetch on mount.
        invalidateAllKernelState(currentKernelId, 'kernel-switch');
      }

      let spec: import('../types').KernelSpec;
      if (language === 'julia') {
        spec = {
          language: 'julia' as const,
          env: cfg.juliaPath ? { JULIA_PATH: cfg.juliaPath } : undefined,
        };
      } else {
        spec = {
          language: 'python' as const,
          argv: cfg.pythonPath ? [cfg.pythonPath, '-m', 'ipykernel_launcher', '-f', '{connection_file}'] : undefined,
          env: cfg.pythonPath ? { PYTHON_PATH: cfg.pythonPath } : undefined,
        };
      }

      const kernel = await window.pdv.kernels.start(spec, uvContext);
      setCurrentKernelId(kernel.id);
      // A launch context is only supplied for per-project-environment
      // launches; its presence is the authoritative signal that this kernel
      // runs in a project env — uv for Python (§10.5), pkg for Julia (§10.6).
      setEnvironmentMode(uvContext ? (language === 'julia' ? 'pkg' : 'uv') : 'shared');
      // In case the kernel id was reused, make sure nothing stale survives.
      invalidateAllKernelState(kernel.id, 'kernel-switch');
      setKernelStatus('ready');
      return true;
    } catch (error) {
      console.error('[App] Failed to start kernel:', error);
      const msg = error instanceof Error ? error.message : String(error);
      setCurrentKernelId(null);
      setKernelStatus('error');
      lastErrorRef.current = msg;
      setLastError(msg);
      return false;
    }
  }, [
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setEnvironmentMode,
  ]);

  /** Start (or restart) a kernel. Returns `true` on success, `false` on failure. */
  const startKernel = useCallback((cfg: Config, language: 'python' | 'julia' = 'python', uvContext?: import('../types').KernelUvContext): Promise<boolean> => {
    // If a start is already in-flight, queue this call (replacing any
    // previously queued call — only the latest wins).
    const prev = pendingStartRef.current;
    if (prev) prev.resolve(false);

    return new Promise<boolean>((resolve) => {
      pendingStartRef.current = { cfg, language, uvContext, resolve };
      // Chain onto the current start so it runs after completion.
      startQueueRef.current = startQueueRef.current
        .catch(() => {})
        .then(() => {
          const queued = pendingStartRef.current;
          if (!queued || queued.resolve !== resolve) {
            // A newer call replaced us in the queue.
            resolve(false);
            return false;
          }
          pendingStartRef.current = null;
          return doStartKernel(queued.cfg, queued.language, queued.uvContext).then((ok) => {
            queued.resolve(ok);
            return ok;
          });
        });
    });
  }, [doStartKernel]);

  const handleEnvSave = useCallback(async (
    paths: { pythonPath?: string; juliaPath?: string },
    opts?: { restart?: boolean },
  ): Promise<boolean> => {
    const language = paths.juliaPath && !paths.pythonPath ? 'julia' : 'python';
    const updatedConfig: Config = {
      kernelSpec: config?.kernelSpec ?? null,
      cwd: config?.cwd ?? '',
      trusted: config?.trusted ?? false,
      recentProjects: config?.recentProjects ?? [],
      pythonPath: paths.pythonPath ?? config?.pythonPath,
      juliaPath: paths.juliaPath ?? config?.juliaPath,
      treeRoot: config?.treeRoot,
      settings: config?.settings,
    };

    await window.pdv.config.set(updatedConfig);
    setConfig(updatedConfig);
    // restart: false — a session is already running; the selection only
    // updates the global default runtime for future sessions. Never stop
    // or demote the live session's environment (§10.5.19).
    if (opts?.restart === false) return true;
    return startKernel(updatedConfig, language);
  }, [config, setConfig, startKernel]);

  const handleRestartKernel = useCallback(async () => {
    if (!currentKernelId) return;

    try {
      setKernelStatus('starting');
      setLastError(undefined);
      const { kernel, restoredFromAutosave } =
        await window.pdv.kernels.restart(currentKernelId);
      setCurrentKernelId(kernel.id);
      setKernelStatus('ready');
      // Replace the log history with a single entry saying what came back,
      // so a crash-restart user knows whether their work was recovered.
      setLogs([{
        id: `restart-${Date.now()}`,
        timestamp: Date.now(),
        code: '',
        stdout: restoredFromAutosave
          ? 'Session restarted — restored from the last autosave.'
          : 'Session restarted — no autosave found; starting fresh.',
      }]);
      // The restarted kernel starts from autosave (or fresh): every cached
      // listing is suspect. Remove the old and (possibly reused) new ids.
      invalidateAllKernelState(currentKernelId, 'kernel-switch');
      invalidateAllKernelState(kernel.id, 'kernel-switch');
    } catch (error) {
      console.error('[App] Failed to restart kernel:', error);
      setKernelStatus('error');
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setLogs,
  ]);

  return {
    startKernel,
    handleEnvSave,
    handleRestartKernel,
    lastErrorRef,
  };
}
