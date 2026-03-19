/**
 * NamelistEditor.tsx — Inline namelist editor widget for module GUIs.
 *
 * Reads a PDVNamelist tree node via `window.pdv.namelist.read()`, renders
 * groups as collapsible sections with typed input fields, and writes
 * edits back via `window.pdv.namelist.write()` on explicit Save.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ModuleInputValue } from "../ModulesPanel/moduleUiHelpers";
import "../../styles/module-gui.css";

interface NamelistEditorProps {
  treePath: string;
  kernelId: string;
  moduleAlias: string;
  treePathInputId?: string;
  inputValues: Record<string, ModuleInputValue>;
}

interface NamelistState {
  groups: Record<string, Record<string, unknown>>;
  hints: Record<string, Record<string, string>>;
  types: Record<string, Record<string, string>>;
  format: "fortran" | "toml";
}

export const NamelistEditor: React.FC<NamelistEditorProps> = ({
  treePath,
  kernelId,
  moduleAlias,
  treePathInputId,
  inputValues,
}) => {
  const [state, setState] = useState<NamelistState | null>(null);
  const [editedValues, setEditedValues] = useState<Record<string, Record<string, unknown>>>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve effective path (may be overridden by a dropdown input)
  const effectivePath = useMemo(() => {
    if (treePathInputId) {
      const key = `${moduleAlias}:${treePathInputId}`;
      const override = inputValues[key];
      if (typeof override === "string" && override.trim()) {
        return override;
      }
    }
    return treePath;
  }, [treePath, treePathInputId, moduleAlias, inputValues]);

  // Load namelist data
  const loadNamelist = useCallback(async () => {
    if (!kernelId || !effectivePath) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.pdv.namelist.read(kernelId, effectivePath);
      setState(result);
      setEditedValues(JSON.parse(JSON.stringify(result.groups)));
      setDirtyKeys(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [kernelId, effectivePath]);

  useEffect(() => {
    void loadNamelist();
  }, [loadNamelist]);

  // Handle value edits
  const handleChange = useCallback(
    (group: string, key: string, value: unknown) => {
      setEditedValues((prev) => ({
        ...prev,
        [group]: {
          ...prev[group],
          [key]: value,
        },
      }));
      setDirtyKeys((prev) => new Set(prev).add(`${group}.${key}`));
    },
    []
  );

  // Save
  const handleSave = useCallback(async () => {
    if (!kernelId || !effectivePath || !state) return;
    setSaving(true);
    try {
      // Coerce any remaining string values to numbers based on type hints,
      // in case the user clicked Save without blurring a numeric field.
      const coerced: Record<string, Record<string, unknown>> = {};
      for (const [group, fields] of Object.entries(editedValues)) {
        coerced[group] = { ...fields };
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value !== "string") continue;
          const typeHint = state.types[group]?.[key];
          if (typeHint === "int" || typeHint === "float") {
            const raw = value.trim();
            if (raw === "") continue;
            const parsed = typeHint === "int" ? parseInt(raw, 10) : parseFloat(raw);
            if (!Number.isNaN(parsed)) {
              coerced[group][key] = parsed;
            }
          }
        }
      }
      const result = await window.pdv.namelist.write(
        kernelId,
        effectivePath,
        coerced
      );
      if (result.success) {
        setDirtyKeys(new Set());
      } else {
        setError(result.error ?? "Save failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [kernelId, effectivePath, editedValues, state]);

  if (loading) {
    return <div className="namelist-editor namelist-loading">Loading namelist...</div>;
  }

  if (error) {
    return (
      <div className="namelist-editor namelist-error">
        <span>{error}</span>
        <button className="namelist-retry-btn" onClick={() => void loadNamelist()}>
          Retry
        </button>
      </div>
    );
  }

  if (!state) {
    return <div className="namelist-editor">No namelist data available.</div>;
  }

  const groupNames = Object.keys(editedValues);

  return (
    <div className="namelist-editor">
      {dirtyKeys.size > 0 && (
        <div className="namelist-save-bar">
          <span className="namelist-dirty-count">
            {dirtyKeys.size} unsaved change{dirtyKeys.size > 1 ? "s" : ""}
          </span>
          <button
            className="namelist-save-btn"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
      {groupNames.map((group) => (
        <details key={group} className="namelist-group" open>
          <summary className="namelist-group-summary">{group}</summary>
          <div className="namelist-group-body">
            {Object.entries(editedValues[group] ?? {}).map(([key, value]) => {
              const hint =
                state.hints[group]?.[key] ?? undefined;
              const typeHint = state.types[group]?.[key] ?? "str";
              const isDirty = dirtyKeys.has(`${group}.${key}`);

              return (
                <div
                  key={key}
                  className={`namelist-key-row ${isDirty ? "namelist-dirty" : ""}`}
                >
                  <label className="namelist-key-label" title={hint}>
                    {key}
                    {hint && (
                      <span className="namelist-hint" title={hint}>
                        {" "}
                        ?
                      </span>
                    )}
                  </label>
                  <div className="namelist-key-value">
                    <NamelistField
                      value={value}
                      typeHint={typeHint}
                      onChange={(v) => handleChange(group, key, v)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Internal: typed field renderer
// ---------------------------------------------------------------------------

interface NamelistFieldProps {
  value: unknown;
  typeHint: string;
  onChange: (value: unknown) => void;
}

const NamelistField: React.FC<NamelistFieldProps> = ({
  value,
  typeHint,
  onChange,
}) => {
  if (typeHint === "bool") {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }

  if (typeHint === "int" || typeHint === "float") {
    // Use text input to avoid browser number-input quirks (spinner buttons,
    // clearing on intermediate zeros like "0.0"). Parse to number on blur
    // so the stored value is numeric when valid; keep raw string while typing.
    const display = value === null || value === undefined ? "" : String(value);
    return (
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return;
          const parsed =
            typeHint === "int" ? parseInt(raw, 10) : parseFloat(raw);
          if (!Number.isNaN(parsed)) {
            onChange(parsed);
          }
        }}
      />
    );
  }

  if (typeHint === "array") {
    const arr = Array.isArray(value) ? value : [];
    const text = arr.join(", ");
    return (
      <input
        type="text"
        value={text}
        onChange={(e) => {
          const parts = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => {
              const n = Number(s);
              return Number.isNaN(n) ? s : n;
            });
          onChange(parts);
        }}
      />
    );
  }

  // Default: string
  return (
    <input
      type="text"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};
