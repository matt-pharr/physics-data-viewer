import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportedModuleDescriptor,
  ModuleDescriptor,
  ModuleImportResult,
  ModuleInstallResult,
} from "../../types";

interface ModulesPanelProps {
  projectDir: string | null;
  isActive: boolean;
  kernelId: string | null;
  kernelReady: boolean;
  onExecute: (code: string) => Promise<void>;
  view: 'library' | 'imported';
  refreshToken?: number;
}

/** Pending import conflict awaiting user decision. */
interface ImportConflict {
  moduleId: string;
  existingAlias: string;
  suggestedAlias: string;
}

/** Pending install duplicate awaiting user acknowledgement. */
interface InstallDuplicate {
  moduleName: string;
  status: "up_to_date" | "update_available" | "incompatible_update";
  currentVersion: string;
  currentRevision?: string;
  candidateVersion?: string;
  candidateRevision?: string;
}

type ModuleInputValue = string | number | boolean;
type ModuleInputDescriptor = ImportedModuleDescriptor["inputs"][number];

const DEFAULT_MODULE_TAB = "General";
const ACTIVE_TAB_SETTING_KEY = "__ui_active_tab__";
const SECTION_OPEN_SETTING_PREFIX = "__ui_section_open__:";

function sectionSettingKey(tab: string, section: string): string {
  return `${SECTION_OPEN_SETTING_PREFIX}${tab}::${section}`;
}

function isModuleInputValue(value: unknown): value is ModuleInputValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function getInputTabName(input: ModuleInputDescriptor): string {
  return input.tab && input.tab.trim().length > 0 ? input.tab : DEFAULT_MODULE_TAB;
}

function getInputSectionName(input: ModuleInputDescriptor): string | null {
  if (!input.section) return null;
  const trimmed = input.section.trim();
  return trimmed.length > 0 ? trimmed : null;
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [installedModules, importedModules] = await Promise.all([
        window.pdv.modules.listInstalled(),
        window.pdv.modules.listImported(),
      ]);
      const settingsByAlias: Record<string, Record<string, unknown>> = {};
      const valuesByKey: Record<string, ModuleInputValue> = {};
      const activeTabsByAlias: Record<string, string> = {};
      const sectionStateByAlias: Record<string, Record<string, boolean>> = {};
      for (const moduleEntry of importedModules) {
        const settings =
          moduleEntry.settings &&
          typeof moduleEntry.settings === "object" &&
          !Array.isArray(moduleEntry.settings)
            ? moduleEntry.settings
            : {};
        settingsByAlias[moduleEntry.alias] = settings;
        const tabNames = Array.from(
          new Set(moduleEntry.inputs.map((input) => getInputTabName(input)))
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
      setImported(importedModules);
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
        if (importedModules.length === 0) return null;
        if (current && importedModules.some((entry) => entry.alias === current)) {
          return current;
        }
        return importedModules[0].alias;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh, refreshToken]);

  const selectedImported = useMemo(
    () => imported.find((entry) => entry.alias === activeImportedAlias) ?? null,
    [imported, activeImportedAlias]
  );

  const selectedModuleTabs = useMemo(() => {
    if (!selectedImported) return [] as string[];
    return Array.from(new Set(selectedImported.inputs.map((input) => getInputTabName(input))));
  }, [selectedImported]);

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
      if (input.control === "file") {
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? JSON.stringify(trimmed) : null;
      }
      if (input.control === "dropdown") {
        if (typeof value === "string") {
          return JSON.stringify(value);
        }
        return value;
      }
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

  /** Render a status badge for an installed module in the library view. */
  const renderModuleBadges = (entry: ModuleDescriptor): React.ReactNode => {
    const badges: React.ReactNode[] = [];
    if (importedModuleIds.has(entry.id)) {
      badges.push(
        <span key="imported" className="modules-status-badge modules-badge-imported">
          Imported
        </span>
      );
    }
    const warnCount = warningCountByModuleId.get(entry.id);
    if (warnCount && warnCount > 0) {
      badges.push(
        <span key="warning" className="modules-warning-badge" title={`${warnCount} warning${warnCount === 1 ? "" : "s"}`}>
          {warnCount}
        </span>
      );
    }
    return badges.length > 0 ? <span className="modules-badge-group">{badges}</span> : null;
  };

  /** Format a version/revision label for display. */
  const formatVersionLabel = (version: string, revision?: string): string => {
    if (revision) {
      return `v${version} (${revision.slice(0, 8)})`;
    }
    return `v${version}`;
  };

  return (
    <div className="modules-panel">
      {view === 'library' && <div className="modules-library">
        <div className="modules-library-header">
          <strong>Library</strong>
          <div className="modules-library-actions">
            <button className="btn btn-secondary" onClick={() => void refresh()} disabled={loading}>Refresh</button>
            <button className="btn btn-secondary" onClick={() => void handleInstallLocal()} disabled={loading}>Install Local</button>
            <button className="btn btn-secondary" onClick={() => void handleInstallGithub()} disabled={loading}>Install GitHub</button>
          </div>
        </div>
        {!projectDir && (
          <div className="modules-inline-note">
            Imported modules will be saved when the project is saved.
          </div>
        )}
        {loading && <div className="modules-inline-note">Loading modules…</div>}
        {error && <div className="modules-error">{error}</div>}
        {lastStatus && <div className="modules-inline-note">{lastStatus}</div>}

        {/* Step 11: In-panel install duplicate/update prompt. */}
        {installDuplicate && (
          <div className={`modules-prompt-block ${installDuplicate.status === "incompatible_update" ? "modules-prompt-error" : installDuplicate.status === "update_available" ? "modules-prompt-warning" : ""}`}>
            <div className="modules-prompt-title">
              {installDuplicate.status === "up_to_date" && "Already up to date"}
              {installDuplicate.status === "update_available" && "Update available"}
              {installDuplicate.status === "incompatible_update" && "Incompatible update"}
            </div>
            <div className="modules-prompt-detail">
              <strong>{installDuplicate.moduleName}</strong>
            </div>
            <div className="modules-prompt-detail">
              Installed: {formatVersionLabel(installDuplicate.currentVersion, installDuplicate.currentRevision)}
            </div>
            {installDuplicate.candidateVersion && installDuplicate.status !== "up_to_date" && (
              <div className="modules-prompt-detail">
                Available: {formatVersionLabel(installDuplicate.candidateVersion, installDuplicate.candidateRevision)}
              </div>
            )}
            {installDuplicate.status === "incompatible_update" && (
              <div className="modules-prompt-detail modules-prompt-caution">
                Major version change detected. This update may break existing usage.
              </div>
            )}
            <div className="modules-prompt-actions">
              <button className="btn btn-secondary" onClick={() => setInstallDuplicate(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Step 11: In-panel import conflict prompt. */}
        {importConflict && (
          <div className="modules-prompt-block modules-prompt-warning">
            <div className="modules-prompt-title">Import alias conflict</div>
            <div className="modules-prompt-detail">
              Alias <strong>"{importConflict.existingAlias}"</strong> is already in use.
            </div>
            <div className="modules-prompt-detail">
              Import as <strong>"{importConflict.suggestedAlias}"</strong> instead?
            </div>
            <div className="modules-prompt-actions">
              <button className="btn btn-primary" onClick={() => void handleConflictAccept()}>
                Import as "{importConflict.suggestedAlias}"
              </button>
              <button className="btn btn-secondary" onClick={handleConflictCancel}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {installed.length === 0 ? (
          <div className="modules-inline-note">No installed modules.</div>
        ) : (
          <ul className="modules-list">
            {installed.map((entry) => (
              <li key={entry.id} className="modules-list-item">
                <div>
                  <div className="modules-name">
                    {entry.name}
                    {renderModuleBadges(entry)}
                  </div>
                  <div className="modules-meta">
                    {entry.id} · v{entry.version}
                    {entry.description && ` · ${entry.description}`}
                  </div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => void handleImport(entry.id)}
                  disabled={loading}
                >
                  Import
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>}
      {view === 'imported' && <div className="modules-imported">
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
                  onClick={() => setActiveImportedAlias(entry.alias)}
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

                {/* Input fields */}
                {selectedImported.inputs.length > 0 && (
                  <div className="modules-inputs">
                    {selectedModuleTabs.length > 1 && (
                      <div className="modules-input-tabs">
                        {selectedModuleTabs.map((tabName) => {
                          const activeTab =
                            activeModuleTabByAlias[selectedImported.alias] ??
                            selectedModuleTabs[0] ??
                            DEFAULT_MODULE_TAB;
                          return (
                            <button
                              key={tabName}
                              className={`modules-tab ${tabName === activeTab ? "active" : ""}`}
                              onClick={() =>
                                void setModuleTab(selectedImported.alias, tabName).catch((err) => {
                                  setError(err instanceof Error ? err.message : String(err));
                                })
                              }
                              title={`Show ${tabName} settings`}
                            >
                              {tabName}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {(() => {
                      const activeTab =
                        activeModuleTabByAlias[selectedImported.alias] ??
                        selectedModuleTabs[0] ??
                        DEFAULT_MODULE_TAB;
                      const tabInputs = selectedImported.inputs.filter(
                        (input) =>
                          getInputTabName(input) === activeTab &&
                          isInputVisible(selectedImported.alias, input)
                      );
                      const unsectioned = tabInputs.filter(
                        (input) => getInputSectionName(input) === null
                      );
                      const sectionNames = Array.from(
                        new Set(
                          tabInputs
                            .map((input) => getInputSectionName(input))
                            .filter((value): value is string => value !== null)
                        )
                      );
                      const renderInputControl = (input: ModuleInputDescriptor): React.ReactNode => {
                        const key = `${selectedImported.alias}:${input.id}`;
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
                                setModuleInputValue(
                                  selectedImported.alias,
                                  input.id,
                                  event.target.checked
                                )
                              }
                              onBlur={() =>
                                void persistInputValues(selectedImported.alias).catch((err) => {
                                  setError(err instanceof Error ? err.message : String(err));
                                })
                              }
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
                                setModuleInputValue(selectedImported.alias, input.id, option.value);
                              }}
                              onBlur={() =>
                                void persistInputValues(selectedImported.alias).catch((err) => {
                                  setError(err instanceof Error ? err.message : String(err));
                                })
                              }
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
                                  setModuleInputValue(
                                    selectedImported.alias,
                                    input.id,
                                    Number(event.target.value)
                                  )
                                }
                                onMouseUp={() =>
                                  void persistInputValues(selectedImported.alias).catch((err) => {
                                    setError(err instanceof Error ? err.message : String(err));
                                  })
                                }
                                onTouchEnd={() =>
                                  void persistInputValues(selectedImported.alias).catch((err) => {
                                    setError(err instanceof Error ? err.message : String(err));
                                  })
                                }
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
                                    setModuleInputValue(selectedImported.alias, input.id, picked);
                                    await persistInputValues(selectedImported.alias);
                                  })().catch((err) => {
                                    setError(err instanceof Error ? err.message : String(err));
                                  })
                                }
                                title={title}
                              >
                                Browse…
                              </button>
                            </div>
                          );
                        }
                        const textValue =
                          typeof value === "string"
                            ? value
                            : value !== undefined
                              ? String(value)
                              : "";
                        return (
                          <input
                            id={inputId}
                            className="modules-input-field"
                            type="text"
                            value={textValue}
                            onChange={(event) =>
                              setModuleInputValue(selectedImported.alias, input.id, event.target.value)
                            }
                            onBlur={() =>
                              void persistInputValues(selectedImported.alias).catch((err) => {
                                setError(err instanceof Error ? err.message : String(err));
                              })
                            }
                            placeholder={typeof input.default === "string" ? input.default : undefined}
                            title={title}
                          />
                        );
                      };

                      return (
                        <>
                          {unsectioned.map((input) => (
                            <div key={input.id} className="modules-input-row">
                              <label
                                className="modules-input-label"
                                htmlFor={`input-${selectedImported.alias}:${input.id}`}
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
                            const isOpen =
                              sectionOpenByAlias[selectedImported.alias]?.[stateKey] ?? defaultOpen;
                            return (
                              <details
                                key={stateKey}
                                className="modules-input-section"
                                open={isOpen}
                                onToggle={(event) =>
                                  void setSectionOpenState(
                                    selectedImported.alias,
                                    activeTab,
                                    sectionName,
                                    (event.currentTarget as HTMLDetailsElement).open
                                  ).catch((err) => {
                                    setError(err instanceof Error ? err.message : String(err));
                                  })
                                }
                              >
                                <summary className="modules-input-section-summary">
                                  {sectionName}
                                </summary>
                                <div className="modules-input-section-body">
                                  {sectionInputs.map((input) => (
                                    <div key={input.id} className="modules-input-row">
                                      <label
                                        className="modules-input-label"
                                        htmlFor={`input-${selectedImported.alias}:${input.id}`}
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
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* Action buttons */}
                {selectedImported.actions.length === 0 ? (
                  <div className="modules-inline-note">This module defines no actions.</div>
                ) : (
                  <div className="modules-actions">
                    {selectedImported.actions.map((action) => {
                      const actionKey = `${selectedImported.alias}:${action.id}`;
                      const isRunning = runningActionKey === actionKey;
                      return (
                        <div key={action.id} className="modules-action-row">
                          <div className="modules-action-meta">
                            <div className="modules-name">{action.label}</div>
                            <div className="modules-meta">
                              {action.inputIds && action.inputIds.length > 0
                                ? `inputs: ${action.inputIds.join(", ")}`
                                : "no inputs"}
                            </div>
                          </div>
                          <button
                            className="btn btn-primary"
                            onClick={() => void handleRunAction(action.id)}
                            disabled={isRunning || !kernelReady || !kernelId}
                          >
                            {isRunning ? "Running..." : "Run"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>}
    </div>
  );
};
