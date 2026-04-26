import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Config, LogEntry } from '../types';

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
  /** Bumps the token to trigger a NamespaceView refetch. */
  setNamespaceRefreshToken: Dispatch<SetStateAction<number>>;
  /** Bumps the token to trigger a Tree panel refetch. */
  setTreeRefreshToken: Dispatch<SetStateAction<number>>;
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
    setNamespaceRefreshToken,
    setTreeRefreshToken,
  } = options;

  // Serializes startKernel calls so only one runs at a time.
  // A second call while one is in-flight queues and replaces any
  // previously queued call (only the latest queued call runs).
  const startQueueRef = useRef<Promise<boolean>>(Promise.resolve(false));
  const pendingStartRef = useRef<{ cfg: Config; language: 'python' | 'julia'; resolve: (v: boolean) => void } | null>(null);

  const doStartKernel = useCallback(async (cfg: Config, language: 'python' | 'julia' = 'python'): Promise<boolean> => {
    setKernelStatus('starting');
    setLastError(undefined);
    try {
      if (currentKernelId) {
        await window.pdv.kernels.stop(currentKernelId);
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

      const kernel = await window.pdv.kernels.start(spec);
      setCurrentKernelId(kernel.id);
      setTreeRefreshToken((prev) => prev + 1);
      setNamespaceRefreshToken((prev) => prev + 1);
      setKernelStatus('ready');
      return true;
    } catch (error) {
      console.error('[App] Failed to start kernel:', error);
      setCurrentKernelId(null);
      setKernelStatus('error');
      setLastError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setNamespaceRefreshToken,
    setTreeRefreshToken,
  ]);

  /** Start (or restart) a kernel. Returns `true` on success, `false` on failure. */
  const startKernel = useCallback((cfg: Config, language: 'python' | 'julia' = 'python'): Promise<boolean> => {
    // If a start is already in-flight, queue this call (replacing any
    // previously queued call — only the latest wins).
    const prev = pendingStartRef.current;
    if (prev) prev.resolve(false);

    return new Promise<boolean>((resolve) => {
      pendingStartRef.current = { cfg, language, resolve };
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
          return doStartKernel(queued.cfg, queued.language).then((ok) => {
            queued.resolve(ok);
            return ok;
          });
        });
    });
  }, [doStartKernel]);

  const handleEnvSave = useCallback(async (paths: { pythonPath?: string; juliaPath?: string }): Promise<boolean> => {
    const language = paths.juliaPath && !paths.pythonPath ? 'julia' : 'python';
    const updatedConfig: Config = {
      kernelSpec: config?.kernelSpec ?? null,
      cwd: config?.cwd ?? '',
      trusted: config?.trusted ?? false,
      recentProjects: config?.recentProjects ?? [],
      pythonPath: paths.pythonPath ?? config?.pythonPath,
      juliaPath: paths.juliaPath ?? config?.juliaPath,
      editors: config?.editors,
      treeRoot: config?.treeRoot,
      settings: config?.settings,
    };

    await window.pdv.config.set(updatedConfig);
    setConfig(updatedConfig);
    return startKernel(updatedConfig, language);
  }, [config, setConfig, startKernel]);

  const handleRestartKernel = useCallback(async () => {
    if (!currentKernelId) return;

    try {
      setKernelStatus('starting');
      setLastError(undefined);
      const newKernel = await window.pdv.kernels.restart(currentKernelId);
      setCurrentKernelId(newKernel.id);
      setKernelStatus('ready');
      setLogs([]);
      setNamespaceRefreshToken((prev) => prev + 1);
      setTreeRefreshToken((prev) => prev + 1);
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
    setNamespaceRefreshToken,
    setTreeRefreshToken,
  ]);

  return {
    startKernel,
    handleEnvSave,
    handleRestartKernel,
  };
}
