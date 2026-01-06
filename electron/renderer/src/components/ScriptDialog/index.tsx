import React, { useEffect, useState } from 'react';
import type { ScriptParameter } from '../../../main/ipc';

interface ScriptDialogProps {
  scriptPath: string;
  scriptName: string;
  onRun: (params: Record<string, unknown>) => void;
  onCancel: () => void;
}

export const ScriptDialog: React.FC<ScriptDialogProps> = ({
  scriptPath,
  scriptName,
  onRun,
  onCancel,
}) => {
  const [params, setParams] = useState<ScriptParameter[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const fetchParams = async () => {
      setLoading(true);
      try {
        const result = await window.pdv.script.getParams(scriptPath);
        if (result.success && result.params) {
          setParams(result.params);

          const defaultValues: Record<string, unknown> = {};
          for (const param of result.params) {
            if (param.default !== undefined) {
              defaultValues[param.name] = param.default;
            }
          }
          setValues(defaultValues);
        } else {
          setError(result.error || 'Failed to load parameters');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    void fetchParams();
  }, [scriptPath]);

  const handleChange = (paramName: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [paramName]: value }));
  };

  const handleRun = () => {
    onRun(values);
  };

  const canRun = () => params.every((p) => !p.required || values[p.name] !== undefined);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="script-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Run Script</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            ×
          </button>
        </div>

        <div className="dialog-body">
          <div className="script-info">
            <strong>{scriptName}</strong>
            <span className="script-path">{scriptPath}</span>
          </div>

          {loading && <div className="dialog-loading">Loading parameters...</div>}
          {error && <div className="dialog-error">{error}</div>}
          {!loading && !error && params.length === 0 && (
            <div className="dialog-info-text">This script has no parameters</div>
          )}

          {!loading && !error && params.length > 0 && (
            <div className="param-list">
              {params.map((param) => (
                <div key={param.name} className="param-input">
                  <label>
                    {param.name}
                    {param.required && <span className="required">*</span>}
                    <span className="param-type">({param.type})</span>
                  </label>

                  {param.type.toLowerCase().includes('str') || param.type === 'String' ? (
                    <input
                      type="text"
                      value={(values[param.name] as string) ?? ''}
                      onChange={(e) => handleChange(param.name, e.target.value)}
                      placeholder={param.default ? String(param.default) : ''}
                    />
                  ) : param.type.toLowerCase().includes('int') || param.type.includes('Int') ? (
                    <input
                      type="number"
                      step="1"
                      value={(values[param.name] as number) ?? 0}
                      onChange={(e) => handleChange(param.name, parseInt(e.target.value, 10))}
                      placeholder={param.default ? String(param.default) : '0'}
                    />
                  ) : param.type.toLowerCase().includes('float') || param.type.includes('Float') ? (
                    <input
                      type="number"
                      step="0.01"
                      value={(values[param.name] as number) ?? 0}
                      onChange={(e) => handleChange(param.name, parseFloat(e.target.value))}
                      placeholder={param.default ? String(param.default) : '0.0'}
                    />
                  ) : param.type.toLowerCase().includes('bool') || param.type === 'Bool' ? (
                    <input
                      type="checkbox"
                      checked={(values[param.name] as boolean) || false}
                      onChange={(e) => handleChange(param.name, e.target.checked)}
                    />
                  ) : (
                    <input
                      type="text"
                      value={String(values[param.name] ?? '')}
                      onChange={(e) => handleChange(param.name, e.target.value)}
                      placeholder={param.default ? String(param.default) : ''}
                    />
                  )}

                  {param.description && <span className="param-description">{param.description}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleRun} disabled={!canRun()}>
            Run
          </button>
        </div>
      </div>
    </div>
  );
};
