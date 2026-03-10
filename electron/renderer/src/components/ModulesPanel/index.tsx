import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportedModuleDescriptor,
  ModuleDescriptor,
  ModuleImportResult,
  ModuleInstallResult,
} from "../../types";
import { ImportedModulesView } from "./ImportedModulesView";
import { ModulesLibraryView } from "./ModulesLibraryView";
import {
  ACTIVE_TAB_SETTING_KEY,
  DEFAULT_MODULE_TAB,
  getActionTabName,
  getInputSectionName,
  getInputTabName,
  isModuleInputValue,
  sectionSettingKey,
  type ImportConflict,
  type InstallDuplicate,
  type ModuleInputDescriptor,
  type ModuleInputValue,
} from "./moduleUiHelpers";

interface ModulesPanelProps {
  projectDir: string | null;
  isActive: boolean;
  kernelId: string | null;
  kernelReady: boolean;
  onExecute: (code: string) => Promise<void>;
  view: 'library' | 'imported';
  refreshToken?: number;
}

/**
 * Modules panel UI — Feature 2 Steps 7-11.
 */
export const ModulesPanel: React.FC<ModulesPanelProps> = ({
  projectDir,
  isActive,
  kernelId,
  kernelReady,
  onExecute,
  view,
  refreshToken,
}) => {
  const [installed, setInstalled] = useState<ModuleDescriptor[]>([]);
  const [imported, setImported] = useState<ImportedModuleDescriptor[]>([]);
  const [activeImportedAlias, setActiveImportedAlias] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const [runningActionKey, setRunningActionKey] = useState<string | null>(null);
  /** Input field values keyed by `<alias>:<inputId>`. */
  const [inputValues, setInputValues] = useState<Record<string, ModuleInputValue>>({});
  const [persistedSettingsByAlias, setPersistedSettingsByAlias] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [activeModuleTabByAlias, setActiveModuleTabByAlias] = useState<
    Record<string, string>
  >({});
  const [sectionOpenByAlias, setSectionOpenByAlias] = useState<
    Record<string, Record<string, boolean>>
  >({});

  // Step 11: in-panel prompts for import conflicts and install duplicates.
  const [importConflict, setImportConflict] = useState<ImportConflict | null>(null);
  const [installDuplicate, setInstallDuplicate] = useState<InstallDuplicate | null>(null);

  const resolveTreeBackedDropdownOptions = useCallback(
    async (
      importedModules: ImportedModuleDescriptor[]
    ): Promise<ImportedModuleDescriptor[]> => {
      if (!kernelId || !kernelReady) {
        return importedModules;
      }
      return Promise.all(
        importedModules.map(async (moduleEntry) => ({
          ...moduleEntry,
          inputs: await Promise.all(
            moduleEntry.inputs.map(async (input) => {
              if (input.control !== "dropdown" || !input.optionsTreePath) {
                return input;
              }
              const treePath = input.optionsTreePath.trim();
              if (!treePath) {
                return { ...input, options: [] };
              }
              const nodes = await window.pdv.tree.list(kernelId, treePath);
              return {
                ...input,
                options: nodes.map((node) => ({ label: node.key, value: node.key })),
              };
            })
          ),
        }))
      );
    },
    [kernelId, kernelReady]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [installedModules, importedModules] = await Promise.all([
        window.pdv.modules.listInstalled(),
        window.pdv.modules.listImported(),
      ]);
      const importedModulesWithResolvedOptions =
        await resolveTreeBackedDropdownOptions(importedModules);
      const settingsByAlias: Record<string, Record<string, unknown>> = {};
      const valuesByKey: Record<string, ModuleInputValue> = {};
      const activeTabsByAlias: Record<string, string> = {};
      const sectionStateByAlias: Record<string, Record<string, boolean>> = {};
      for (const moduleEntry of importedModulesWithResolvedOptions) {
        const settings =
          moduleEntry.settings &&
          typeof moduleEntry.settings === "object" &&
          !Array.isArray(moduleEntry.settings)
            ? moduleEntry.settings
            : {};
        settingsByAlias[moduleEntry.alias] = settings;
        const tabNames = Array.from(
          new Set([
            ...moduleEntry.inputs.map((input) => getInputTabName(input)),
            ...moduleEntry.actions.map((action) => getActionTabName(action)),
          ])
        );
        const savedTab = settings[ACTIVE_TAB_SETTING_KEY];
        activeTabsByAlias[moduleEntry.alias] =
          typeof savedTab === "string" && tabNames.includes(savedTab)
            ? savedTab
            : (tabNames[0] ?? DEFAULT_MODULE_TAB);

        // Restore persisted input values and UI section state from settings.
        const sectionOpenState: Record<string, boolean> = {};
        for (const input of moduleEntry.inputs) {
          const key = `${moduleEntry.alias}:${input.id}`;
          const persisted = settings[input.id];
          if (isModuleInputValue(persisted)) {
            valuesByKey[key] = persisted;
          } else if (input.default !== undefined) {
            valuesByKey[key] = input.default;
          }
          const tabName = getInputTabName(input);
          const sectionName = getInputSectionName(input);
          if (!sectionName) continue;
          const stateKey = `${tabName}::${sectionName}`;
          if (sectionOpenState[stateKey] !== undefined) continue;
          const savedOpen = settings[sectionSettingKey(tabName, sectionName)];
          if (typeof savedOpen === "boolean") {
            sectionOpenState[stateKey] = savedOpen;
          } else {
            sectionOpenState[stateKey] = !(input.sectionCollapsed ?? false);
          }
        }
        sectionStateByAlias[moduleEntry.alias] = sectionOpenState;
      }
      setInstalled(installedModules);
      setImported(importedModulesWithResolvedOptions);
      setPersistedSettingsByAlias(settingsByAlias);
      setActiveModuleTabByAlias((prev) => ({ ...prev, ...activeTabsByAlias }));
      setSectionOpenByAlias((prev) => ({ ...prev, ...sectionStateByAlias }));
      setInputValues((prev) => {
        // Merge: keep user edits for keys that still exist, add new defaults.
        const merged = { ...valuesByKey };
        for (const [k, v] of Object.entries(prev)) {
          if (k in merged) {
            merged[k] = v; // keep user's in-progress edits
          }
        }
        return merged;
      });
      setActiveImportedAlias((current) => {
        if (importedModulesWithResolvedOptions.length === 0) return null;
        if (
          current &&
          importedModulesWithResolvedOptions.some((entry) => entry.alias === current)
        ) {
          return current;
        }
        return importedModulesWithResolvedOptions[0].alias;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [resolveTreeBackedDropdownOptions]);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh, refreshToken, kernelId]);

  const selectedImported = useMemo(
    () => imported.find((entry) => entry.alias === activeImportedAlias) ?? null,
    [imported, activeImportedAlias]
  );

  const selectedModuleTabs = useMemo(() => {
    if (!selectedImported) return [] as string[];
    return Array.from(
      new Set([
        ...selectedImported.inputs.map((input) => getInputTabName(input)),
        ...selectedImported.actions.map((action) => getActionTabName(action)),
      ])
    );
  }, [selectedImported]);

  const activeSelectedTab = useMemo(() => {
    if (!selectedImported) return DEFAULT_MODULE_TAB;
    const firstTab = selectedModuleTabs[0] ?? DEFAULT_MODULE_TAB;
    const saved = activeModuleTabByAlias[selectedImported.alias];
    return saved && selectedModuleTabs.includes(saved) ? saved : firstTab;
  }, [selectedImported, selectedModuleTabs, activeModuleTabByAlias]);

  // Compute which module IDs are already imported in the active project.
  const importedModuleIds = useMemo(
    () => new Set(imported.map((entry) => entry.moduleId)),
    [imported]
  );

  // Compute warning counts per installed module ID (from imported warnings).
  const warningCountByModuleId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of imported) {
      if (entry.warnings.length > 0) {
        counts.set(entry.moduleId, (counts.get(entry.moduleId) ?? 0) + entry.warnings.length);
      }
    }
    return counts;
  }, [imported]);

  const handleInstallResult = async (result: ModuleInstallResult): Promise<void> => {
    if (!result.success && result.error) {
      setError(result.error);
      setLastStatus(null);
      return;
    }
    setError(null);

    // Step 11: show in-panel prompt for duplicate install states.
    if (
      result.status === "up_to_date" ||
      result.status === "update_available" ||
      result.status === "incompatible_update"
    ) {
      setInstallDuplicate({
        moduleName: result.module?.name ?? result.module?.id ?? "Module",
        status: result.status,
        currentVersion: result.currentVersion ?? "unknown",
        currentRevision: result.currentRevision,
        candidateVersion: result.module?.version,
        candidateRevision: result.module?.revision,
      });
      setLastStatus(null);
      await refresh();
      return;
    }

    setLastStatus(result.module ? `Installed: ${result.module.name} v${result.module.version}` : `Install status: ${result.status}`);
    await refresh();
  };

  const handleInstallLocal = async (): Promise<void> => {
    const localPath = await window.pdv.files.pickDirectory();
    if (!localPath) return;
    setInstallDuplicate(null);
    const result = await window.pdv.modules.install({
      source: {
        type: "local",
        location: localPath,
      },
    });
    await handleInstallResult(result);
  };

  const handleInstallGithub = async (): Promise<void> => {
    const url = window.prompt("GitHub repository URL");
    if (!url || !url.trim()) return;
    setInstallDuplicate(null);
    const result = await window.pdv.modules.install({
      source: {
        type: "github",
        location: url.trim(),
      },
    });
    await handleInstallResult(result);
  };

  const handleImport = async (moduleId: string): Promise<void> => {
    setError(null);
    setImportConflict(null);
    const result = await window.pdv.modules.importToProject({ moduleId });
    if (result.status === "conflict" && result.suggestedAlias) {
      // Step 11: show in-panel conflict prompt instead of window.confirm.
      setImportConflict({
        moduleId,
        existingAlias: result.alias ?? moduleId,
        suggestedAlias: result.suggestedAlias,
      });
      return;
    }
    await handleImportResult(result);
  };

  const handleConflictAccept = async (): Promise<void> => {
    if (!importConflict) return;
    setImportConflict(null);
    const retried = await window.pdv.modules.importToProject({
      moduleId: importConflict.moduleId,
      alias: importConflict.suggestedAlias,
    });
    await handleImportResult(retried);
  };

  const handleConflictCancel = (): void => {
    setImportConflict(null);
    setLastStatus("Import cancelled.");
  };

  const handleImportResult = async (result: ModuleImportResult): Promise<void> => {
    if (!result.success && result.error) {
      setError(result.error);
    } else {
      setError(null);
    }
    const warningSuffix =
      result.warnings && result.warnings.length > 0
        ? ` · ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`
        : "";
    setLastStatus(
      `Imported${result.alias ? ` as "${result.alias}"` : ""}${warningSuffix}`
    );
    await refresh();
  };

  const persistModuleSettings = useCallback(
    async (moduleAlias: string, nextSettings: Record<string, unknown>): Promise<void> => {
      const result = await window.pdv.modules.saveSettings({
        moduleAlias,
        values: nextSettings,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Failed to save module settings");
      }
      setPersistedSettingsByAlias((prev) => ({
        ...prev,
        [moduleAlias]: nextSettings,
      }));
    },
    []
  );

  /** Persist all current input values for a module alias to settings. */
  const persistInputValues = useCallback(
    async (moduleAlias: string): Promise<void> => {
      const mod = imported.find((entry) => entry.alias === moduleAlias);
      if (!mod) return;
      const nextSettings = { ...(persistedSettingsByAlias[moduleAlias] ?? {}) };
      for (const input of mod.inputs) {
        const key = `${moduleAlias}:${input.id}`;
        const val = inputValues[key];
        if (typeof val === "string") {
          const trimmed = val.trim();
          if (trimmed.length > 0) {
            nextSettings[input.id] = trimmed;
          } else {
            delete nextSettings[input.id];
          }
          continue;
        }
        if (typeof val === "number" || typeof val === "boolean") {
          nextSettings[input.id] = val;
          continue;
        }
        delete nextSettings[input.id];
      }
      await persistModuleSettings(moduleAlias, nextSettings);
    },
    [imported, inputValues, persistedSettingsByAlias, persistModuleSettings]
  );

  const setModuleInputValue = useCallback(
    (moduleAlias: string, inputId: string, value: ModuleInputValue): void => {
      const key = `${moduleAlias}:${inputId}`;
      setInputValues((prev) => ({
        ...prev,
        [key]: value,
      }));
    },
    []
  );

  const isInputVisible = useCallback(
    (moduleAlias: string, input: ModuleInputDescriptor): boolean => {
      if (!input.visibleIf) {
        return true;
      }
      const dependencyKey = `${moduleAlias}:${input.visibleIf.inputId}`;
      const dependencyValue = inputValues[dependencyKey];
      return dependencyValue === input.visibleIf.equals;
    },
    [inputValues]
  );

  const setModuleTab = useCallback(
    async (moduleAlias: string, tabName: string): Promise<void> => {
      setActiveModuleTabByAlias((prev) => ({
        ...prev,
        [moduleAlias]: tabName,
      }));
      const nextSettings = {
        ...(persistedSettingsByAlias[moduleAlias] ?? {}),
        [ACTIVE_TAB_SETTING_KEY]: tabName,
      };
      await persistModuleSettings(moduleAlias, nextSettings);
    },
    [persistModuleSettings, persistedSettingsByAlias]
  );

  const setSectionOpenState = useCallback(
    async (
      moduleAlias: string,
      tabName: string,
      sectionName: string,
      isOpen: boolean
    ): Promise<void> => {
      const stateKey = `${tabName}::${sectionName}`;
      setSectionOpenByAlias((prev) => ({
        ...prev,
        [moduleAlias]: {
          ...(prev[moduleAlias] ?? {}),
          [stateKey]: isOpen,
        },
      }));
      const nextSettings = {
        ...(persistedSettingsByAlias[moduleAlias] ?? {}),
        [sectionSettingKey(tabName, sectionName)]: isOpen,
      };
      await persistModuleSettings(moduleAlias, nextSettings);
    },
    [persistModuleSettings, persistedSettingsByAlias]
  );

  const toActionInputValue = useCallback(
    (value: ModuleInputValue | undefined, input: ModuleInputDescriptor): ModuleInputValue | null => {
      if (value === undefined) {
        return null;
      }
      if (input.control === "checkbox") {
        return Boolean(value);
      }
      if (input.control === "slider") {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === "string") {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      }
      // File, dropdown, text — pass string values through as-is.
      // Python quoting is handled by toPythonArgumentValue in the main process.
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      return value;
    },
    []
  );

  const handleRunAction = async (actionId: string): Promise<void> => {
    if (!selectedImported) return;
    if (!kernelId || !kernelReady) {
      setError("Start a ready kernel before running module actions.");
      return;
    }
    const actionKey = `${selectedImported.alias}:${actionId}`;
    const action = selectedImported.actions.find((a) => a.id === actionId);
    if (!action) return;

    setRunningActionKey(actionKey);
    setError(null);
    try {
      // Persist input values before running.
      await persistInputValues(selectedImported.alias);

      // Collect input values referenced by this action.
      const actionInputValues: Record<string, ModuleInputValue> = {};
      const referencedIds = action.inputIds ?? [];
      const inputById = new Map(selectedImported.inputs.map((input) => [input.id, input] as const));
      for (const inputId of referencedIds) {
        const key = `${selectedImported.alias}:${inputId}`;
        const input = inputById.get(inputId);
        if (!input) continue;
        const value = toActionInputValue(inputValues[key], input);
        if (value !== null) {
          actionInputValues[inputId] = value;
        }
      }

      const result = await window.pdv.modules.runAction({
        kernelId,
        moduleAlias: selectedImported.alias,
        actionId,
        inputValues: Object.keys(actionInputValues).length > 0 ? actionInputValues : undefined,
      });
      if (!result.success || !result.executionCode) {
        throw new Error(result.error ?? `Failed to run action ${actionId}`);
      }
      await onExecute(result.executionCode);
      setLastStatus(`Action queued: ${selectedImported.alias}.${actionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningActionKey(null);
    }
  };

  const setErrorMessage = useCallback((message: string): void => {
    setError(message);
  }, []);

  return (
    <div className="modules-panel">
      {view === 'library' && (
        <ModulesLibraryView
          projectDir={projectDir}
          loading={loading}
          error={error}
          lastStatus={lastStatus}
          installDuplicate={installDuplicate}
          importConflict={importConflict}
          installed={installed}
          importedModuleIds={importedModuleIds}
          warningCountByModuleId={warningCountByModuleId}
          onRefresh={refresh}
          onInstallLocal={handleInstallLocal}
          onInstallGithub={handleInstallGithub}
          onDismissInstallDuplicate={() => setInstallDuplicate(null)}
          onConflictAccept={handleConflictAccept}
          onConflictCancel={handleConflictCancel}
          onImport={handleImport}
        />
      )}
      {view === 'imported' && (
        <ImportedModulesView
          imported={imported}
          activeImportedAlias={activeImportedAlias}
          selectedImported={selectedImported}
          selectedModuleTabs={selectedModuleTabs}
          activeSelectedTab={activeSelectedTab}
          kernelReady={kernelReady}
          kernelId={kernelId}
          runningActionKey={runningActionKey}
          inputValues={inputValues}
          sectionOpenByAlias={sectionOpenByAlias}
          onSelectAlias={(alias) => setActiveImportedAlias(alias)}
          onSetModuleTab={setModuleTab}
          onSetError={setErrorMessage}
          isInputVisible={isInputVisible}
          setModuleInputValue={setModuleInputValue}
          persistInputValues={persistInputValues}
          setSectionOpenState={setSectionOpenState}
          onRunAction={handleRunAction}
        />
      )}
    </div>
  );
};
