import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { Config, LogEntry } from '../types';

type KernelStatus = 'idle' | 'starting' | 'ready' | 'error';

interface UseKernelLifecycleOptions {
  config: Config | null;
  currentKernelId: string | null;
  setCurrentKernelId: Dispatch<SetStateAction<string | null>>;
  setKernelStatus: Dispatch<SetStateAction<KernelStatus>>;
  setLastError: Dispatch<SetStateAction<string | undefined>>;
  setShowEnvSelector: Dispatch<SetStateAction<boolean>>;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setNamespaceRefreshToken: Dispatch<SetStateAction<number>>;
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

  const startKernel = useCallback(async (cfg: Config) => {
    setKernelStatus('starting');
    setLastError(undefined);
    try {
      if (currentKernelId) {
        await window.pdv.kernels.stop(currentKernelId);
      }

      const spec = {
        language: 'python' as const,
        argv: cfg.pythonPath ? [cfg.pythonPath, '-m', 'ipykernel_launcher', '-f', '{connection_file}'] : undefined,
        env: cfg.pythonPath ? { PYTHON_PATH: cfg.pythonPath } : undefined,
      };

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

  const handleEnvSave = useCallback(async (paths: { pythonPath: string; juliaPath?: string }) => {
    const updatedConfig: Config = {
      kernelSpec: config?.kernelSpec ?? null,
      cwd: config?.cwd ?? '',
      trusted: config?.trusted ?? false,
      recentProjects: config?.recentProjects ?? [],
      customKernels: config?.customKernels ?? [],
      pythonPath: paths.pythonPath,
      juliaPath: paths.juliaPath ?? config?.juliaPath,
      editors: config?.editors,
      treeRoot: config?.treeRoot,
      settings: config?.settings,
    };

    await window.pdv.config.set(updatedConfig);
    setConfig(updatedConfig);
    setShowEnvSelector(false);
    await startKernel(updatedConfig);
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
