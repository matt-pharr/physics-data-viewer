import React, { useMemo, useState } from 'react';
import type { KernelExecuteResult, ScriptParameter, TreeNodeData } from '../../types';

interface ScriptDialogProps {
  node: TreeNodeData;
  kernelId: string;
  onRun: (code: string, result: KernelExecuteResult) => void;
  onCancel: () => void;
}

function getParamKind(type: string): 'string' | 'int' | 'float' | 'bool' {
  const normalized = type.toLowerCase();
  if (normalized.includes('bool')) return 'bool';
  if (normalized.includes('int')) return 'int';
  if (normalized.includes('float')) return 'float';
  return 'string';
}

function isValueProvided(param: ScriptParameter, values: Record<string, unknown>): boolean {
  const value = values[param.name];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

export const ScriptDialog: React.FC<ScriptDialogProps> = ({ node, kernelId, onRun, onCancel }) => {
  const params = useMemo(() => node.params ?? [], [node.params]);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const defaults: Record<string, unknown> = {};
    for (const param of params) {
      if (param.default !== undefined && param.default !== null) {
        defaults[param.name] = param.default;
      }
    }
    return defaults;
  });
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleChange = (paramName: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [paramName]: value }));
  };

  const canRun = params.every((param) => !param.required || isValueProvided(param, values));

  const handleRun = async () => {
    if (!canRun || isRunning) {
      return;
    }

    setIsRunning(true);
    setError(undefined);
    try {
      const args = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(', ');
      const invocation = args.length > 0 ? `(${args})` : '()';
      const code = `pdv_tree[${JSON.stringify(node.path)}].run${invocation}`;
      const result = await window.pdv.kernels.execute(kernelId, { code });
      onRun(code, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

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
            <strong>{node.key}</strong>
            <span className="script-path">{node.path}</span>
          </div>

          {params.length === 0 && <div className="dialog-info-text">This script has no parameters</div>}

          {params.length > 0 && (
            <div className="param-list">
              {params.map((param) => {
                const kind = getParamKind(param.type);
                return (
                  <div key={param.name} className="param-input">
                    <label>
                      {param.name}
                      {param.required && <span className="required">*</span>}
                      <span className="param-type">({param.type})</span>
                    </label>

                    {kind === 'int' && (
                      <input
                        type="number"
                        step="1"
                        value={values[param.name] === undefined ? '' : String(values[param.name])}
                        onChange={(e) =>
                          handleChange(
                            param.name,
                            e.target.value === '' ? undefined : Number.parseInt(e.target.value, 10),
                          )
                        }
                        placeholder={param.default === null ? '' : String(param.default ?? '')}
                      />
                    )}

                    {kind === 'float' && (
                      <input
                        type="number"
                        step="0.01"
                        value={values[param.name] === undefined ? '' : String(values[param.name])}
                        onChange={(e) =>
                          handleChange(
                            param.name,
                            e.target.value === '' ? undefined : Number.parseFloat(e.target.value),
                          )
                        }
                        placeholder={param.default === null ? '' : String(param.default ?? '')}
                      />
                    )}

                    {kind === 'bool' && (
                      <input
                        type="checkbox"
                        checked={Boolean(values[param.name])}
                        onChange={(e) => handleChange(param.name, e.target.checked)}
                      />
                    )}

                    {kind === 'string' && (
                      <input
                        type="text"
                        value={(values[param.name] as string) ?? ''}
                        onChange={(e) => handleChange(param.name, e.target.value)}
                        placeholder={param.default === null ? '' : String(param.default ?? '')}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {error && <div className="dialog-error">{error}</div>}
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel} disabled={isRunning}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void handleRun()} disabled={!canRun || isRunning}>
            {isRunning ? 'Running...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
};
