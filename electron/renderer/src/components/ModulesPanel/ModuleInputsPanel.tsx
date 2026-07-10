import React from "react";

import type { ImportedModuleDescriptor } from "../../types";
import { captureError } from "../../utils/errors";
import { InputControl } from "../ModuleGui/InputControl";
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
  const onCaughtError = captureError(onError);

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

  // Each row (label + control) renders through the shared InputControl —
  // the same component ContainerRenderer uses for GUI layouts — so the two
  // surfaces cannot drift.
  const renderInputRow = (input: ModuleInputDescriptor): React.ReactNode => (
    <InputControl
      key={input.id}
      moduleAlias={moduleAlias}
      input={input}
      value={inputValues[`${moduleAlias}:${input.id}`]}
      setModuleInputValue={setModuleInputValue}
      persistInputValues={persistInputValues}
      onError={onError}
    />
  );

  if (inputs.length === 0) {
    return null;
  }

  return (
    <div className="modules-inputs">
      {unsectioned.map(renderInputRow)}

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
              ).catch(onCaughtError)
            }
          >
            <summary className="modules-input-section-summary">{sectionName}</summary>
            <div className="modules-input-section-body">
              {sectionInputs.map(renderInputRow)}
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
