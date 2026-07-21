/**
 * app/useKernelLaunch.ts — Session-launch overlay machinery (EnvSyncModal).
 *
 * Owns the unified `kernelLaunch` state that drives the blocking launch
 * overlay for both uv-project launches (env materialization + kernel boot)
 * and shared/conda kernel launches (kernel boot only), the uv-output
 * streaming subscription that feeds it, and the launch / retry / cancel /
 * choose-environment callbacks around it.
 *
 * Does NOT start kernels itself — the actual stop/start handshake lives in
 * useKernelLifecycle's `startKernel`, injected via options. Does NOT decide
 * which environment a project should launch with: App's welcome/open flows
 * pick uv vs pkg vs shared and call `launchUvKernel` / `launchPkgKernel` /
 * `launchSharedKernel`.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Config, KernelUvContext } from '../types';

/** Options for {@link useKernelLaunch}. All setters correspond to App-level useState. */
interface UseKernelLaunchOptions {
  /** Current app configuration (interpreter paths for uv/shared launches). */
  config: Config | null;
  /** Starts (or restarts) a kernel — from useKernelLifecycle. Resolves true on success. */
  startKernel: (cfg: Config, language?: 'python' | 'julia', uvContext?: KernelUvContext) => Promise<boolean>;
  /** Synchronous mirror of the last kernel-start error — from useKernelLifecycle. */
  lastErrorRef: MutableRefObject<string | undefined>;
  /** Records which language the session is launching as (status bar, dialogs). */
  setActiveLanguage: Dispatch<SetStateAction<'python' | 'julia'>>;
  /** Opens Settings → Runtime with an optional interpreter warning (shared-launch failures). */
  openEnvSettings: (warning?: string) => void;
  /** Returns to the welcome screen after an abandoned launch. */
  setForceWelcome: Dispatch<SetStateAction<boolean>>;
}

export function useKernelLaunch(options: UseKernelLaunchOptions) {
  const {
    config,
    startKernel,
    lastErrorRef,
    setActiveLanguage,
    openEnvSettings,
    setForceWelcome,
  } = options;

  // Unified session-launch overlay state (EnvSyncModal): covers uv-project
  // launches (env materialization + kernel boot) and shared/conda kernel
  // launches (kernel boot only). `mode` selects the failure affordances
  // (shared failures offer "Choose environment…").
  const [kernelLaunch, setKernelLaunch] = useState<{
    phase: 'idle' | 'syncing' | 'failed';
    stage: 'env' | 'kernel-boot';
    mode: 'uv' | 'shared' | 'pkg';
    language: 'python' | 'julia';
    detail?: string;
    output: string;
    error?: string;
  }>({ phase: 'idle', stage: 'env', mode: 'uv', language: 'python', output: '' });
  const lastUvLaunchRef = useRef<KernelUvContext | null>(null);
  // Replays the most recent launch (uv, pkg, or shared) for the overlay's Retry.
  const lastLaunchRef = useRef<(() => Promise<boolean>) | null>(null);
  // Self-refs so a launch can enqueue its own replay without a TDZ cycle
  // between the launch callbacks.
  const launchUvKernelRef = useRef<(ctx: KernelUvContext) => Promise<boolean>>(async () => false);
  const launchPkgKernelRef = useRef<(ctx: KernelUvContext) => Promise<boolean>>(async () => false);
  const launchSharedKernelRef = useRef<(cfg: Config, language: 'python' | 'julia') => Promise<boolean>>(async () => false);

  // --- session launch overlay ---------------------------------------------
  // Stream uv output into the EnvSyncModal while a launch runs. A
  // `stage: "kernel-boot"` marker (empty data) flips the modal's title
  // from environment setup to kernel startup.
  useEffect(() => {
    const unsub = window.pdv.environment.onEnvActivity((chunk) => {
      setKernelLaunch((s) =>
        s.phase === 'idle'
          ? s
          : {
              ...s,
              output: s.output + chunk.data,
              stage: chunk.stage === 'kernel-boot' ? 'kernel-boot' : s.stage,
            });
    });
    return unsub;
  }, []);

  /**
   * Launch (or relaunch) a uv-project kernel behind the blocking EnvSyncModal.
   * Resolves true on success; on failure the modal stays up with Retry/Cancel.
   */
  const launchUvKernel = useCallback(async (uvContext: KernelUvContext): Promise<boolean> => {
    lastUvLaunchRef.current = uvContext;
    lastLaunchRef.current = () => launchUvKernelRef.current(uvContext);
    setActiveLanguage('python');
    setKernelLaunch({ phase: 'syncing', stage: 'env', mode: 'uv', language: 'python', output: '' });
    const ok = await startKernel(config ?? {} as Config, 'python', uvContext);
    if (ok) {
      setKernelLaunch({ phase: 'idle', stage: 'env', mode: 'uv', language: 'python', output: '' });
    } else {
      setKernelLaunch((s) => ({ ...s, phase: 'failed', error: lastErrorRef.current }));
    }
    return ok;
  }, [config, startKernel, lastErrorRef, setActiveLanguage]);

  /**
   * Launch (or relaunch) a pkg-mode Julia kernel (§10.6) behind the blocking
   * EnvSyncModal. The main process overlaps `Pkg.instantiate` with the kernel
   * boot; the overlay starts at the environment stage and flips to
   * kernel-boot on the instantiate-complete marker. Resolves true on
   * success; on failure the modal stays up with Retry/Cancel.
   */
  const launchPkgKernel = useCallback(async (pkgContext: KernelUvContext): Promise<boolean> => {
    lastLaunchRef.current = () => launchPkgKernelRef.current(pkgContext);
    setActiveLanguage('julia');
    setKernelLaunch({
      phase: 'syncing',
      stage: 'env',
      mode: 'pkg',
      language: 'julia',
      detail: config?.juliaPath,
      output: '',
    });
    const ok = await startKernel(config ?? {} as Config, 'julia', pkgContext);
    if (ok) {
      setKernelLaunch({ phase: 'idle', stage: 'env', mode: 'uv', language: 'python', output: '' });
    } else {
      setKernelLaunch((s) => ({ ...s, phase: 'failed', error: lastErrorRef.current }));
    }
    return ok;
  }, [config, startKernel, lastErrorRef, setActiveLanguage]);

  /**
   * Launch (or relaunch) a shared-environment (conda/system) kernel behind
   * the same blocking overlay as uv launches: "Starting ipykernel…" while
   * the kernel boots, and on failure the modal stays up with
   * Retry / Choose environment… / Cancel.
   */
  const launchSharedKernel = useCallback(async (cfg: Config, language: 'python' | 'julia'): Promise<boolean> => {
    lastLaunchRef.current = () => launchSharedKernelRef.current(cfg, language);
    setActiveLanguage(language);
    setKernelLaunch({
      phase: 'syncing',
      stage: 'kernel-boot',
      mode: 'shared',
      language,
      detail: language === 'julia' ? cfg.juliaPath : cfg.pythonPath,
      output: '',
    });
    const ok = await startKernel(cfg, language);
    if (ok) {
      setKernelLaunch({ phase: 'idle', stage: 'env', mode: 'uv', language: 'python', output: '' });
    } else {
      setKernelLaunch((s) => ({ ...s, phase: 'failed', error: lastErrorRef.current }));
    }
    return ok;
  }, [startKernel, lastErrorRef, setActiveLanguage]);

  // Keep the self-refs current so a stored Retry closure always replays
  // through the latest launch implementation.
  useEffect(() => {
    launchUvKernelRef.current = launchUvKernel;
    launchPkgKernelRef.current = launchPkgKernel;
    launchSharedKernelRef.current = launchSharedKernel;
  }, [launchUvKernel, launchPkgKernel, launchSharedKernel]);

  /** Retry a failed session launch (replays the last uv or shared launch). */
  const handleLaunchRetry = useCallback(() => {
    void lastLaunchRef.current?.();
  }, []);

  /** Abandon a failed session launch and return to the welcome screen. */
  const handleLaunchCancel = useCallback(() => {
    setKernelLaunch({ phase: 'idle', stage: 'env', mode: 'uv', language: 'python', output: '' });
    setForceWelcome(true);
  }, [setForceWelcome]);

  /** Leave a failed shared/pkg launch for the environment selector (Settings → Runtime). */
  const handleLaunchChooseEnv = useCallback(() => {
    const error = kernelLaunch.error;
    setKernelLaunch({ phase: 'idle', stage: 'env', mode: 'uv', language: 'python', output: '' });
    openEnvSettings(error ?? 'Kernel failed to start.');
  }, [kernelLaunch.error, openEnvSettings]);

  return {
    kernelLaunch,
    launchUvKernel,
    launchPkgKernel,
    launchSharedKernel,
    handleLaunchRetry,
    handleLaunchCancel,
    handleLaunchChooseEnv,
  };
}
