/**
 * Environment selector dialog/panel for Python/Julia executable paths.
 *
 * Validates interpreter paths through `window.pdv.kernels.validate` and emits
 * chosen values to the parent component for persistence/restart handling.
 * Adapts its UI based on which kernel language is currently active.
 */

import React, { useState } from 'react';

interface EnvironmentSelectorProps {
  isFirstRun: boolean;
  activeLanguage?: 'python' | 'julia';
  currentConfig?: { pythonPath?: string; juliaPath?: string };
  currentKernelId?: string | null;
  embedded?: boolean;
  onSave: (config: { pythonPath?: string; juliaPath?: string; language?: 'python' | 'julia' }) => void;
  onRestart?: () => void;
  onCancel?: () => void;
}

/** Runtime executable configuration UI used on first-run and in Settings. */
export const EnvironmentSelector: React.FC<EnvironmentSelectorProps> = ({
  isFirstRun,
  activeLanguage = 'python',
  currentConfig,
  currentKernelId,
  embedded = false,
  onSave,
  onRestart,
  onCancel,
}) => {
  const [pythonPath, setPythonPath] = useState(currentConfig?.pythonPath || 'python3');
  const [juliaPath, setJuliaPath] = useState(currentConfig?.juliaPath || 'julia');
  const [validating, setValidating] = useState(false);
  const [errors, setErrors] = useState<{ python?: string; julia?: string }>({});

  const handleValidate = async () => {
    setValidating(true);
    setErrors({});
    try {
      if (!window.pdv?.kernels) {
        throw new Error('PDV preload API is unavailable. Open the Electron window, not localhost in a browser.');
      }

      const nextErrors: { python?: string; julia?: string } = {};

      if (activeLanguage === 'julia') {
        const juliaValid = await window.pdv.kernels.validate(juliaPath, 'julia');
        if (!juliaValid.valid) {
          nextErrors.julia = juliaValid.error || 'Unable to validate Julia environment';
        }
      } else {
        const pythonValid = await window.pdv.kernels.validate(pythonPath, 'python');
        if (!pythonValid.valid) {
          nextErrors.python = pythonValid.error || 'Unable to validate Python interpreter';
        }
      }

      setErrors(nextErrors);
      if (!nextErrors.python && !nextErrors.julia) {
        if (activeLanguage === 'julia') {
          onSave({ juliaPath: juliaPath || undefined, language: 'julia' });
        } else {
          onSave({ pythonPath, language: 'python' });
        }
      }
    } catch (error) {
      const key = activeLanguage === 'julia' ? 'julia' : 'python';
      setErrors({
        [key]: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setValidating(false);
    }
  };

  const handleSaveWithoutValidation = () => {
    if (activeLanguage === 'julia') {
      onSave({ juliaPath: juliaPath || undefined, language: 'julia' });
    } else {
      onSave({ pythonPath, language: 'python' });
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
      const key = language === 'julia' ? 'julia' : 'python';
      setErrors({
        [key]: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const isPython = activeLanguage === 'python';
  const isJulia = activeLanguage === 'julia';

  const content = (
    <>
      <h2>Configure {isPython ? 'Python' : 'Julia'} Runtime</h2>

      {isFirstRun && (
        <p className="help-text">
          {isPython
            ? 'Please specify a Python executable with ipykernel installed.'
            : 'Please specify a Julia executable with PDVJulia installed.'}
        </p>
      )}

      {/* Primary language section */}
      {isPython && (
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
      )}

      {isJulia && (
        <div className="input-group">
          <label>Julia Executable</label>
          <div className="input-with-button">
            <input
              type="text"
              value={juliaPath}
              onChange={(e) => setJuliaPath(e.target.value)}
              placeholder="/usr/local/bin/julia"
            />
            <button className="btn btn-secondary" onClick={() => handleFilePicker('julia')}>
              Browse
            </button>
          </div>
          {errors.julia && <div className="error-text">{errors.julia}</div>}
          <div className="help-text">
            Requires PDVJulia: <code>] add PDVJulia</code>
          </div>
        </div>
      )}

      {/* Secondary language section (collapsed, for reference) */}
      {isPython && (
        <div className="input-group">
          <label>Julia Executable</label>
          <div className="input-with-button">
            <input
              type="text"
              value={juliaPath}
              onChange={(e) => setJuliaPath(e.target.value)}
              placeholder="/usr/local/bin/julia"
            />
            <button className="btn btn-secondary" onClick={() => handleFilePicker('julia')}>
              Browse
            </button>
          </div>
          <div className="help-text">
            Used when starting Julia kernels. Requires PDVJulia: <code>] add PDVJulia</code>
          </div>
        </div>
      )}

      {isJulia && (
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
          <div className="help-text">
            Used when starting Python kernels. Requires ipykernel: <code>pip install ipykernel</code>
          </div>
        </div>
      )}

      <div className="button-group">
        <button className="btn btn-primary" onClick={handleValidate} disabled={validating}>
          {validating ? 'Validating...' : 'Test & Save'}
        </button>
        <button className="btn btn-secondary" onClick={handleSaveWithoutValidation} disabled={validating}>
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
