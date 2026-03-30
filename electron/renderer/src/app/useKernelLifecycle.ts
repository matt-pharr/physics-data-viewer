import { useCallback, type Dispatch, type SetStateAction } from 'react';
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
  /** Controls visibility of the EnvironmentSelector dialog. */
  setShowEnvSelector: Dispatch<SetStateAction<boolean>>;
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
    setShowEnvSelector,
    setConfig,
    setLogs,
    setNamespaceRefreshToken,
    setTreeRefreshToken,
  } = options;

  const startKernel = useCallback(async (cfg: Config, language: 'python' | 'julia' = 'python') => {
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
    } catch (error) {
      console.error('[App] Failed to start kernel:', error);
      setCurrentKernelId(null);
      setKernelStatus('error');
      setLastError(error instanceof Error ? error.message : String(error));
      setShowEnvSelector(true);
    }
  }, [
    currentKernelId,
    setCurrentKernelId,
    setKernelStatus,
    setLastError,
    setShowEnvSelector,
    setNamespaceRefreshToken,
    setTreeRefreshToken,
  ]);

  const handleEnvSave = useCallback(async (paths: { pythonPath?: string; juliaPath?: string; language?: 'python' | 'julia' }) => {
    const language = paths.language ?? 'python';
    const updatedConfig: Config = {
      kernelSpec: config?.kernelSpec ?? null,
      cwd: config?.cwd ?? '',
      trusted: config?.trusted ?? false,
      recentProjects: config?.recentProjects ?? [],
      customKernels: config?.customKernels ?? [],
      pythonPath: paths.pythonPath ?? config?.pythonPath,
      juliaPath: paths.juliaPath ?? config?.juliaPath,
      editors: config?.editors,
      treeRoot: config?.treeRoot,
      settings: config?.settings,
    };

    await window.pdv.config.set(updatedConfig);
    setConfig(updatedConfig);
    setShowEnvSelector(false);
    await startKernel(updatedConfig, language);
  }, [config, setConfig, setShowEnvSelector, startKernel]);

  const handleRestartKernel = useCallback(async () => {
    if (!currentKernelId) return;

    try {
      setKernelStatus('starting');
      setLastError(undefined);
      const newKernel = await window.pdv.kernels.restart(currentKernelId);
      setCurrentKernelId(newKernel.id);
      setKernelStatus('ready');
      setShowEnvSelector(false);
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
    setShowEnvSelector,
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
