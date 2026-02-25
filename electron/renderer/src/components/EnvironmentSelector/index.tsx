/**
 * Environment selector dialog/panel for Python/Julia executable paths.
 *
 * Validates interpreter paths through `window.pdv.kernels.validate` and emits
 * chosen values to the parent component for persistence/restart handling.
 */

import React, { useState } from 'react';

interface EnvironmentSelectorProps {
  isFirstRun: boolean;
  currentConfig?: { pythonPath?: string; juliaPath?: string };
  currentKernelId?: string | null;
  embedded?: boolean;
  onSave: (config: { pythonPath: string; juliaPath?: string }) => void;
  onRestart?: () => void;
  onCancel?: () => void;
}

/** Runtime executable configuration UI used on first-run and in Settings. */
export const EnvironmentSelector: React.FC<EnvironmentSelectorProps> = ({
  isFirstRun,
  currentConfig,
  currentKernelId,
  embedded = false,
  onSave,
  onRestart,
  onCancel,
}) => {
  const [pythonPath, setPythonPath] = useState(currentConfig?.pythonPath || 'python3');
  const [juliaPath, setJuliaPath] = useState(currentConfig?.juliaPath || '');
  const [validating, setValidating] = useState(false);
  const [errors, setErrors] = useState<{ python?: string; julia?: string }>({});

  const handleValidate = async () => {
    setValidating(true);
    setErrors({});
    try {
      if (!window.pdv?.kernels) {
        throw new Error('PDV preload API is unavailable. Open the Electron window, not localhost in a browser.');
      }
      const pythonValid = await window.pdv.kernels.validate(pythonPath, 'python');
      const nextErrors: { python?: string; julia?: string } = {};
      if (!pythonValid.valid) {
        nextErrors.python = pythonValid.error || 'Unable to validate Python interpreter';
      }
      setErrors(nextErrors);
      if (!nextErrors.python) {
        onSave({ pythonPath, juliaPath: juliaPath || undefined });
      }
    } catch (error) {
      setErrors({
        python: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setValidating(false);
    }
  };

  const handleFilePicker = async (language: 'python' | 'julia') => {
    try {
      if (!window.pdv?.files) {
        throw new Error('PDV preload API is unavailable. Open the Electron window, not localhost in a browser.');
      }
      const result = await window.pdv.files.pickExecutable();
      if (result) {
        if (language === 'python') {
          setPythonPath(result);
        } else {
          setJuliaPath(result);
        }
      }
    } catch (error) {
      setErrors({
        python: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const content = (
    <>
      <h2>Configure Python Runtime</h2>

      {isFirstRun && (
        <p className="help-text">
          Please specify a Python executable with ipykernel installed.
        </p>
      )}

      <div className="input-group">
        <label>Python Executable</label>
        <div className="input-with-button">
          <input
            type="text"
            value={pythonPath}
            onChange={(e) => setPythonPath(e.target.value)}
            placeholder="/usr/bin/python3"
          />
          <button className="btn btn-secondary" onClick={() => handleFilePicker('python')}>
            Browse
          </button>
        </div>
        {errors.python && <div className="error-text">{errors.python}</div>}
        <div className="help-text">
          Requires ipykernel: <code>pip install ipykernel</code>
        </div>
      </div>

      <div className="input-group">
        <label>Julia Executable (deferred)</label>
        <div className="input-with-button">
          <input
            type="text"
            value={juliaPath}
            onChange={(e) => setJuliaPath(e.target.value)}
            placeholder="Optional for future support"
          />
          <button className="btn btn-secondary" onClick={() => handleFilePicker('julia')}>
            Browse
          </button>
        </div>
        <div className="help-text">
          Julia support will be enabled in a future release after Python development milestones are complete.
        </div>
      </div>

      <div className="button-group">
        <button className="btn btn-primary" onClick={handleValidate} disabled={validating}>
          {validating ? 'Validating...' : 'Test & Save'}
        </button>
        <button className="btn btn-secondary" onClick={() => onSave({ pythonPath, juliaPath: juliaPath || undefined })} disabled={validating}>
          Save Without Validation
        </button>
        {!isFirstRun && currentKernelId && onRestart && (
          <button className="btn btn-warning" onClick={onRestart} disabled={validating}>
            Restart Kernel
          </button>
        )}
        {!isFirstRun && onCancel && (
          <button className="btn btn-secondary" onClick={onCancel} disabled={validating}>
            Cancel
          </button>
        )}
      </div>
    </>
  );

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
