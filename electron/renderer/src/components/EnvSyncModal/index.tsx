/**
 * EnvSyncModal — Blocking overlay shown while a uv project's environment is
 * being materialized (`uv sync` + `pdv-python` install) and the kernel boots.
 *
 * Streams uv output so a cold sync doesn't look like a frozen app, and on
 * failure surfaces the verbatim output with Retry / Cancel
 * (ARCHITECTURE.md §10.5.9).
 */

import React, { useLayoutEffect, useRef } from 'react';

interface EnvSyncModalProps {
  /** `'syncing'` while uv runs and the kernel boots; `'failed'` after a failure. */
  phase: 'syncing' | 'failed';
  /** Accumulated uv output streamed over `environment.onEnvActivity`. */
  output: string;
  /** Error message shown above the output when `phase` is `'failed'`. */
  errorMessage?: string;
  /** Re-run the environment setup from scratch. */
  onRetry: () => void;
  /** Abandon setup and return to the welcome screen. */
  onCancel: () => void;
}

/** Blocking modal for uv environment setup (ARCHITECTURE.md §10.5.9). */
export const EnvSyncModal: React.FC<EnvSyncModalProps> = ({
  phase,
  output,
  errorMessage,
  onRetry,
  onCancel,
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
          {failed ? 'Environment setup failed' : 'Setting up project environment…'}
        </div>
        {!failed && (
          <div className="env-sync-subtitle">
            Resolving dependencies with uv. This can take a moment the first time.
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
            <button className="btn btn-primary" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
