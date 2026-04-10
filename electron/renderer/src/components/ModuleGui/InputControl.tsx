/**
 * InputControl.tsx — Renders a single module input control by type.
 *
 * Extracted from ModuleInputsPanel for reuse in the container layout renderer.
 */

import React from "react";
import type { ModuleInputDescriptor, ModuleInputValue } from "../ModulesPanel/moduleUiHelpers";
import { captureError } from "../../utils/errors";

interface InputControlProps {
  moduleAlias: string;
  input: ModuleInputDescriptor;
  value: ModuleInputValue | undefined;
  setModuleInputValue: (moduleAlias: string, inputId: string, value: ModuleInputValue) => void;
  persistInputValues: (moduleAlias: string) => Promise<void>;
  onError: (message: string) => void;
}

export const InputControl: React.FC<InputControlProps> = ({
  moduleAlias,
  input,
  value,
  setModuleInputValue,
  persistInputValues,
  onError,
}) => {
  const onCaughtError = captureError(onError);

  const persistForAlias = (): void => {
    void persistInputValues(moduleAlias).catch(onCaughtError);
  };

  const inputId = `input-${moduleAlias}:${input.id}`;
  const title = input.tooltip ?? "";

  if (input.control === "checkbox") {
    return (
      <div className="modules-input-row">
        <label className="modules-input-label" htmlFor={inputId} title={input.tooltip}>
          {input.label}
        </label>
        <input
          id={inputId}
          className="modules-input-checkbox"
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => {
            setModuleInputValue(moduleAlias, input.id, e.target.checked);
            persistForAlias();
          }}
          onBlur={persistForAlias}
          title={title}
        />
      </div>
    );
  }

  if (input.control === "dropdown") {
    const options = input.options ?? [];
    const selectedIndex = options.findIndex((o) => o.value === value);
    const selectValue = selectedIndex >= 0 ? String(selectedIndex) : "";
    return (
      <div className="modules-input-row">
        <label className="modules-input-label" htmlFor={inputId} title={input.tooltip}>
          {input.label}
        </label>
        <select
          id={inputId}
          className="modules-input-field"
          value={selectValue}
          onChange={(e) => {
            const idx = Number(e.target.value);
            const opt = Number.isInteger(idx) ? options[idx] : undefined;
            if (!opt) return;
            setModuleInputValue(moduleAlias, input.id, opt.value);
          }}
          onBlur={persistForAlias}
          title={title}
        >
          <option value="" disabled>Select...</option>
          {options.map((opt, i) => (
            <option key={`${input.id}-${i}`} value={String(i)}>{opt.label}</option>
          ))}
        </select>
      </div>
    );
  }

  if (input.control === "slider") {
    const min = input.min ?? 0;
    const max = input.max ?? 100;
    const step = input.step ?? 1;
    const sliderValue =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim().length > 0
          ? Number(value)
          : typeof input.default === "number"
            ? input.default
            : min;
    return (
      <div className="modules-input-row">
        <label className="modules-input-label" htmlFor={inputId} title={input.tooltip}>
          {input.label}
        </label>
        <div className="modules-slider-wrap">
          <input
            id={inputId}
            className="modules-input-field"
            type="range"
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(sliderValue) ? sliderValue : min}
            onChange={(e) => setModuleInputValue(moduleAlias, input.id, Number(e.target.value))}
            onMouseUp={persistForAlias}
            onTouchEnd={persistForAlias}
            title={title}
          />
          <span className="modules-slider-value">
            {Number.isFinite(sliderValue) ? sliderValue : min}
          </span>
        </div>
      </div>
    );
  }

  if (input.control === "file") {
    const pathValue =
      typeof value === "string"
        ? value
        : typeof input.default === "string"
          ? input.default
          : "";
    return (
      <div className="modules-input-row">
        <label className="modules-input-label" htmlFor={inputId} title={input.tooltip}>
          {input.label}
        </label>
        <div className="modules-file-wrap">
          <input
            id={inputId}
            className="modules-input-field"
            type="text"
            value={pathValue}
            readOnly
            title={title}
          />
          <button
            className="btn btn-secondary"
            onClick={() =>
              void (async () => {
                const picked =
                  input.fileMode === "directory"
                    ? await window.pdv.files.pickDirectory()
                    : await window.pdv.files.pickFile();
                if (!picked) return;
                setModuleInputValue(moduleAlias, input.id, picked);
                await persistInputValues(moduleAlias);
              })().catch(onCaughtError)
            }
            title={title}
          >
            Browse...
          </button>
        </div>
      </div>
    );
  }

  // Default: text input
  const textValue =
    typeof value === "string" ? value : value !== undefined ? String(value) : "";
  return (
    <div className="modules-input-row">
      <label className="modules-input-label" htmlFor={inputId} title={input.tooltip}>
        {input.label}
      </label>
      <input
        id={inputId}
        className="modules-input-field"
        type="text"
        value={textValue}
        onChange={(e) => setModuleInputValue(moduleAlias, input.id, e.target.value)}
        onBlur={persistForAlias}
        placeholder={typeof input.default === "string" ? input.default : undefined}
        title={title}
      />
    </div>
  );
};
