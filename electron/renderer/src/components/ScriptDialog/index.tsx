/**
 * ScriptDialog — parameter form and runner for `PDVScript` tree nodes.
 *
 * Fetches the script's current run() parameters on demand when the dialog
 * opens, so edits to the script file are always reflected.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { KernelExecutionOrigin, ScriptParameter, ScriptRunResult, TreeNodeData } from '../../types';

interface ScriptDialogProps {
  node: TreeNodeData;
  kernelId: string;
  onRun: (payload: ScriptRunResult) => void;
  onCancel: () => void;
}

/** Map backend parameter type strings to renderer input kinds. */
export function getParamKind(type: string): 'string' | 'int' | 'float' | 'bool' {
  const normalized = type.toLowerCase();
  if (normalized.includes('bool')) return 'bool';
  if (normalized.includes('int')) return 'int';
  if (normalized.includes('float')) return 'float';
  return 'string';
}

/** Return true when a required parameter has a user-provided value. */
export function isValueProvided(param: ScriptParameter, values: Record<string, unknown>): boolean {
  const value = values[param.name];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** Serialize one dialog value to a JSON-safe primitive. */
export function serializeScriptArgValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return null;
}

/** Modal script-run dialog. */
export const ScriptDialog: React.FC<ScriptDialogProps> = ({ node, kernelId, onRun, onCancel }) => {
  const [params, setParams] = useState<ScriptParameter[]>([]);
  const [isLoadingParams, setIsLoadingParams] = useState(true);
  const [paramLoadFailed, setParamLoadFailed] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingParams(true);
    setParamLoadFailed(false);
    setError(undefined);
    window.pdv.script.getParams(kernelId, node.path).then((fetched) => {
      if (cancelled) return;
      setParams(fetched);
      const defaults: Record<string, unknown> = {};
      for (const param of fetched) {
        if (param.default !== undefined && param.default !== null) {
          defaults[param.name] = param.default;
        }
      }
      setValues(defaults);
      setIsLoadingParams(false);
    }).catch((err) => {
      if (cancelled) return;
      setParamLoadFailed(true);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoadingParams(false);
    });
    return () => { cancelled = true; };
  }, [kernelId, node.path]);

  const handleChange = (paramName: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [paramName]: value }));
  };

  const canRun = !isLoadingParams && !paramLoadFailed && params.every((param) => !param.required || isValueProvided(param, values));

  const handleRun = async () => {
    if (!canRun || isRunning) {
      return;
    }

    setIsRunning(true);
    setError(undefined);
    try {
      const params = Object.fromEntries(
        Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .flatMap(([key, value]) => {
          const serialized = serializeScriptArgValue(value);
          return serialized === null ? [] : [[key, serialized] as const];
        })
      );
      const executionId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const origin: KernelExecutionOrigin = {
        kind: 'tree-script',
        label: node.path,
        scriptPath: node.path,
      };
      const runResult = await window.pdv.script.run(kernelId, {
        treePath: node.path,
        params,
        executionId,
        origin,
      });
      onRun(runResult);
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

          {isLoadingParams && <div className="dialog-info-text">Loading parameters...</div>}

          {!isLoadingParams && !paramLoadFailed && params.length === 0 && <div className="dialog-info-text">This script has no parameters</div>}

          {!isLoadingParams && !paramLoadFailed && params.length > 0 && (
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
