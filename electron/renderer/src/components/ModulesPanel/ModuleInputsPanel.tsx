import React from "react";

import type { ImportedModuleDescriptor } from "../../types";
import {
  getInputSectionName,
  getInputTabName,
  type ModuleInputDescriptor,
  type ModuleInputValue,
} from "./moduleUiHelpers";

interface ModuleInputsPanelProps {
  moduleAlias: string;
  inputs: ImportedModuleDescriptor["inputs"];
  activeTab: string;
  inputValues: Record<string, ModuleInputValue>;
  sectionOpenState?: Record<string, boolean>;
  isInputVisible: (moduleAlias: string, input: ModuleInputDescriptor) => boolean;
  setModuleInputValue: (
    moduleAlias: string,
    inputId: string,
    value: ModuleInputValue
  ) => void;
  persistInputValues: (moduleAlias: string) => Promise<void>;
  setSectionOpenState: (
    moduleAlias: string,
    tabName: string,
    sectionName: string,
    isOpen: boolean
  ) => Promise<void>;
  onError: (message: string) => void;
}

/** Render module input controls for the currently selected module tab. */
export const ModuleInputsPanel: React.FC<ModuleInputsPanelProps> = ({
  moduleAlias,
  inputs,
  activeTab,
  inputValues,
  sectionOpenState,
  isInputVisible,
  setModuleInputValue,
  persistInputValues,
  setSectionOpenState,
  onError,
}) => {
  const captureError = (error: unknown): void => {
    onError(error instanceof Error ? error.message : String(error));
  };

  const persistForAlias = (): void => {
    void persistInputValues(moduleAlias).catch(captureError);
  };

  const tabInputs = inputs.filter(
    (input) => getInputTabName(input) === activeTab && isInputVisible(moduleAlias, input)
  );
  const unsectioned = tabInputs.filter((input) => getInputSectionName(input) === null);
  const sectionNames = Array.from(
    new Set(
      tabInputs
        .map((input) => getInputSectionName(input))
        .filter((value): value is string => value !== null)
    )
  );
  const hasPythonTextInputs = tabInputs.some(
    (input) => input.control === undefined || input.control === "text"
  );

  const renderInputControl = (input: ModuleInputDescriptor): React.ReactNode => {
    const key = `${moduleAlias}:${input.id}`;
    const value = inputValues[key];
    const inputId = `input-${key}`;
    const title = input.tooltip ?? "";

    if (input.control === "checkbox") {
      return (
        <input
          id={inputId}
          className="modules-input-checkbox"
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) =>
            setModuleInputValue(moduleAlias, input.id, event.target.checked)
          }
          onBlur={persistForAlias}
          title={title}
        />
      );
    }

    if (input.control === "dropdown") {
      const options = input.options ?? [];
      const selectedIndex = options.findIndex((option) => option.value === value);
      const selectValue = selectedIndex >= 0 ? String(selectedIndex) : "";
      return (
        <select
          id={inputId}
          className="modules-input-field"
          value={selectValue}
          onChange={(event) => {
            const index = Number(event.target.value);
            const option = Number.isInteger(index) ? options[index] : undefined;
            if (!option) return;
            setModuleInputValue(moduleAlias, input.id, option.value);
          }}
          onBlur={persistForAlias}
          title={title}
        >
          <option value="" disabled>
            Select…
          </option>
          {options.map((option, index) => (
            <option key={`${input.id}-${index}`} value={String(index)}>
              {option.label}
            </option>
          ))}
        </select>
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
        <div className="modules-slider-wrap">
          <input
            id={inputId}
            className="modules-input-field"
            type="range"
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(sliderValue) ? sliderValue : min}
            onChange={(event) =>
              setModuleInputValue(moduleAlias, input.id, Number(event.target.value))
            }
            onMouseUp={persistForAlias}
            onTouchEnd={persistForAlias}
            title={title}
          />
          <span className="modules-slider-value">
            {Number.isFinite(sliderValue) ? sliderValue : min}
          </span>
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
              })().catch(captureError)
            }
            title={title}
          >
            Browse…
          </button>
        </div>
      );
    }

    const textValue =
      typeof value === "string" ? value : value !== undefined ? String(value) : "";
    return (
      <input
        id={inputId}
        className="modules-input-field"
        type="text"
        value={textValue}
        onChange={(event) =>
          setModuleInputValue(moduleAlias, input.id, event.target.value)
        }
        onBlur={persistForAlias}
        placeholder={typeof input.default === "string" ? input.default : undefined}
        title={title}
      />
    );
  };

  if (inputs.length === 0) {
    return null;
  }

  return (
    <div className="modules-inputs">
      {unsectioned.map((input) => (
        <div key={input.id} className="modules-input-row">
          <label
            className="modules-input-label"
            htmlFor={`input-${moduleAlias}:${input.id}`}
            title={input.tooltip}
          >
            {input.label}
          </label>
          {renderInputControl(input)}
        </div>
      ))}

      {sectionNames.map((sectionName) => {
        const stateKey = `${activeTab}::${sectionName}`;
        const sectionInputs = tabInputs.filter(
          (input) => getInputSectionName(input) === sectionName
        );
        const defaultOpen = !(sectionInputs[0]?.sectionCollapsed ?? false);
        const isOpen = sectionOpenState?.[stateKey] ?? defaultOpen;
        return (
          <details
            key={stateKey}
            className="modules-input-section"
            open={isOpen}
            onToggle={(event) =>
              void setSectionOpenState(
                moduleAlias,
                activeTab,
                sectionName,
                (event.currentTarget as HTMLDetailsElement).open
              ).catch(captureError)
            }
          >
            <summary className="modules-input-section-summary">{sectionName}</summary>
            <div className="modules-input-section-body">
              {sectionInputs.map((input) => (
                <div key={input.id} className="modules-input-row">
                  <label
                    className="modules-input-label"
                    htmlFor={`input-${moduleAlias}:${input.id}`}
                    title={input.tooltip}
                  >
                    {input.label}
                  </label>
                  {renderInputControl(input)}
                </div>
              ))}
            </div>
          </details>
        );
      })}

      {tabInputs.length === 0 && (
        <div className="modules-inline-note">No visible inputs in this tab.</div>
      )}
      {hasPythonTextInputs && (
        <div className="modules-inline-note">
          Text inputs are evaluated as Python expressions; quote string literals.
        </div>
      )}
    </div>
  );
};
