import React from "react";
import type { ImportedModuleDescriptor } from "../../types";
import { ModuleActionsPanel } from "./ModuleActionsPanel";
import { ModuleInputsPanel } from "./ModuleInputsPanel";
import type { ModuleInputDescriptor, ModuleInputValue } from "./moduleUiHelpers";

interface ImportedModulesViewProps {
  imported: ImportedModuleDescriptor[];
  activeImportedAlias: string | null;
  selectedImported: ImportedModuleDescriptor | null;
  selectedModuleTabs: string[];
  activeSelectedTab: string;
  kernelReady: boolean;
  kernelId: string | null;
  runningActionKey: string | null;
  inputValues: Record<string, ModuleInputValue>;
  sectionOpenByAlias: Record<string, Record<string, boolean>>;
  onSelectAlias: (alias: string) => void;
  onSetModuleTab: (moduleAlias: string, tabName: string) => Promise<void>;
  onSetError: (message: string) => void;
  isInputVisible: (moduleAlias: string, input: ModuleInputDescriptor) => boolean;
  setModuleInputValue: (moduleAlias: string, inputId: string, value: ModuleInputValue) => void;
  persistInputValues: (moduleAlias: string) => Promise<void>;
  setSectionOpenState: (
    moduleAlias: string,
    tabName: string,
    sectionName: string,
    isOpen: boolean
  ) => Promise<void>;
  onRunAction: (actionId: string) => Promise<void>;
}

export const ImportedModulesView: React.FC<ImportedModulesViewProps> = ({
  imported,
  activeImportedAlias,
  selectedImported,
  selectedModuleTabs,
  activeSelectedTab,
  kernelReady,
  kernelId,
  runningActionKey,
  inputValues,
  sectionOpenByAlias,
  onSelectAlias,
  onSetModuleTab,
  onSetError,
  isInputVisible,
  setModuleInputValue,
  persistInputValues,
  setSectionOpenState,
  onRunAction,
}) => (
  <div className="modules-imported">
    <div className="modules-imported-header">
      <strong>Imported Modules</strong>
    </div>
    {imported.length === 0 ? (
      <div className="modules-inline-note">No modules imported in this project.</div>
    ) : (
      <>
        <div className="modules-tabs">
          {imported.map((entry) => (
            <button
              key={entry.alias}
              className={`modules-tab ${entry.alias === activeImportedAlias ? "active" : ""}`}
              onClick={() => onSelectAlias(entry.alias)}
            >
              {entry.alias}
              {entry.warnings.length > 0 && (
                <span className="modules-warning-badge">{entry.warnings.length}</span>
              )}
            </button>
          ))}
        </div>
        {selectedImported && (
          <div className="modules-tab-content">
            <div className="modules-name">{selectedImported.name}</div>
            <div className="modules-meta">
              id: {selectedImported.moduleId} · version: {selectedImported.version}
            </div>
            {selectedImported.warnings.length > 0 && (
              <div className="modules-warning-block">
                {selectedImported.warnings.map((warning, index) => (
                  <div key={`${warning.code}-${index}`} className="modules-warning-item">
                    {warning.message}
                  </div>
                ))}
              </div>
            )}
            {!kernelReady && (
              <div className="modules-inline-note">
                Start a ready kernel to run module actions.
              </div>
            )}

            {selectedModuleTabs.length > 1 && (
              <div className="modules-input-tabs">
                {selectedModuleTabs.map((tabName) => (
                  <button
                    key={tabName}
                    className={`modules-tab ${tabName === activeSelectedTab ? "active" : ""}`}
                    onClick={() =>
                      void onSetModuleTab(selectedImported.alias, tabName).catch((err) => {
                        onSetError(err instanceof Error ? err.message : String(err));
                      })
                    }
                    title={`Show ${tabName} settings`}
                  >
                    {tabName}
                  </button>
                ))}
              </div>
            )}

            <ModuleInputsPanel
              moduleAlias={selectedImported.alias}
              inputs={selectedImported.inputs}
              activeTab={activeSelectedTab}
              inputValues={inputValues}
              sectionOpenState={sectionOpenByAlias[selectedImported.alias]}
              isInputVisible={isInputVisible}
              setModuleInputValue={setModuleInputValue}
              persistInputValues={persistInputValues}
              setSectionOpenState={setSectionOpenState}
              onError={onSetError}
            />

            <ModuleActionsPanel
              moduleAlias={selectedImported.alias}
              actions={selectedImported.actions}
              activeTab={activeSelectedTab}
              runningActionKey={runningActionKey}
              kernelReady={kernelReady}
              kernelId={kernelId}
              onRunAction={onRunAction}
            />
          </div>
        )}
      </>
    )}
  </div>
);
