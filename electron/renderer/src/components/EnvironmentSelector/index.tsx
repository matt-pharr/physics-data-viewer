import React, { useState } from 'react';

interface EnvironmentSelectorProps {
  isFirstRun: boolean;
  currentConfig?: { pythonPath?: string; juliaPath?: string };
  currentKernelId?: string | null;
  onSave: (config: { pythonPath: string; juliaPath: string }) => void;
  onRestart?: () => void;
  onCancel?: () => void;
}

export const EnvironmentSelector: React.FC<EnvironmentSelectorProps> = ({
  isFirstRun,
  currentConfig,
  currentKernelId,
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

    const pythonValid = await window.pdv.kernels.validate(pythonPath, 'python');
    const juliaValid = await window.pdv.kernels.validate(juliaPath, 'julia');

    const nextErrors: { python?: string; julia?: string } = {};
    if (!pythonValid.valid) {
      nextErrors.python = pythonValid.error || 'Unable to validate Python interpreter';
    }
    if (!juliaValid.valid) {
      nextErrors.julia = juliaValid.error || 'Unable to validate Julia interpreter';
    }
    setErrors(nextErrors);
    setValidating(false);

    if (!nextErrors.python && !nextErrors.julia) {
      onSave({ pythonPath, juliaPath });
    }
  };

  const handleFilePicker = async (language: 'python' | 'julia') => {
    const result = await window.pdv.files.pickExecutable();
    if (result) {
      if (language === 'python') {
        setPythonPath(result);
      } else {
        setJuliaPath(result);
      }
    }
  };

  return (
    <div className="modal-overlay">
      <div className="environment-selector">
        <h2>Configure Runtime Environments</h2>

        {isFirstRun && (
          <p className="help-text">
            Please specify paths to Python and Julia executables with Jupyter kernels installed.
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
            Requires IJulia: <code>using Pkg; Pkg.add("IJulia")</code>
          </div>
        </div>

        <div className="button-group">
          <button className="btn btn-primary" onClick={handleValidate} disabled={validating}>
        {validating ? 'Validating...' : 'Test & Save'}
      </button>
      <button className="btn btn-secondary" onClick={() => onSave({ pythonPath, juliaPath })} disabled={validating}>
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
      </div>
    </div>
  );
};
