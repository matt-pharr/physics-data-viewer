/**
 * EnvSyncModal — Blocking session-launch overlay.
 *
 * Covers both launch paths: uv projects (environment materialization
 * streamed as uv output, then kernel boot) and shared/conda environments
 * (kernel boot only). On failure it stays up with Retry / Cancel — plus
 * "Choose environment…" when the host provides `onChooseEnv` (shared
 * launches, where picking a different interpreter is the natural recovery).
 * (ARCHITECTURE.md §10.5.9)
 */

import React, { useLayoutEffect, useRef } from 'react';

interface EnvSyncModalProps {
  /** `'syncing'` while uv runs and the kernel boots; `'failed'` after a failure. */
  phase: 'syncing' | 'failed';
  /**
   * Launch stage within `'syncing'`: `'env'` while uv materializes the
   * environment, `'kernel-boot'` once the kernel process is starting
   * (pushed as a stage marker over `environment.onEnvActivity`).
   * Shared/conda launches start directly at `'kernel-boot'`.
   */
  stage?: 'env' | 'kernel-boot';
  /** Kernel language — selects the kernel-boot title wording. */
  language?: 'python' | 'julia';
  /** Optional detail line for the kernel-boot stage (e.g. interpreter path). */
  detail?: string;
  /** Accumulated uv output streamed over `environment.onEnvActivity`. */
  output: string;
  /** Error message shown above the output when `phase` is `'failed'`. */
  errorMessage?: string;
  /** Re-run the launch from scratch. */
  onRetry: () => void;
  /** Abandon the launch and return to the welcome screen. */
  onCancel: () => void;
  /**
   * When provided, the failed state offers a "Choose environment…" button
   * that hands recovery to the environment selector (shared launches).
   */
  onChooseEnv?: () => void;
}

/** Blocking modal for uv environment setup (ARCHITECTURE.md §10.5.9). */
export const EnvSyncModal: React.FC<EnvSyncModalProps> = ({
  phase,
  stage = 'env',
  language = 'python',
  detail,
  output,
  errorMessage,
  onRetry,
  onCancel,
  onChooseEnv,
}) => {
  const outputRef = useRef<HTMLPreElement>(null);

  // Keep the streamed output pinned to the latest line.
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const failed = phase === 'failed';

  return (
    <div className="env-sync-overlay">
      <div className="env-sync-panel">
        <div className="env-sync-title">
          {failed
            ? 'Session failed to start'
            : stage === 'kernel-boot'
              ? language === 'julia'
                ? 'Starting the Julia kernel…'
                : 'Starting ipykernel…'
              : 'Setting up project environment…'}
        </div>
        {!failed && (
          <div className="env-sync-subtitle">
            {stage === 'kernel-boot'
              ? detail ?? 'The environment is ready — launching the session.'
              : language === 'julia'
                ? 'Resolving project dependencies with Pkg. This can take a moment the first time.'
                : 'Resolving dependencies with uv. This can take a moment the first time.'}
          </div>
        )}
        {failed && errorMessage && (
          <div className="env-sync-error">{errorMessage}</div>
        )}
        {output && (
          <pre className="env-install-output" ref={outputRef}>
            {output}
          </pre>
        )}
        {failed && (
          <div className="env-sync-actions">
            <button className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            {onChooseEnv && (
              <button className="btn btn-secondary" onClick={onChooseEnv}>
                Choose environment…
              </button>
            )}
            <button className="btn btn-primary" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
