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
  const [actionParamsJson, setActionParamsJson] = useState<Record<string, string>>({});
  const [persistedSettingsByAlias, setPersistedSettingsByAlias] = useState<
    Record<string, Record<string, unknown>>
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
      const paramsByActionKey: Record<string, string> = {};
      for (const moduleEntry of importedModules) {
        const settings =
          moduleEntry.settings &&
          typeof moduleEntry.settings === "object" &&
          !Array.isArray(moduleEntry.settings)
            ? moduleEntry.settings
            : {};
        settingsByAlias[moduleEntry.alias] = settings;
        for (const action of moduleEntry.actions) {
          const value = settings[action.id];
          if (value !== undefined) {
            paramsByActionKey[`${moduleEntry.alias}:${action.id}`] = String(value);
          }
        }
      }
      setInstalled(installedModules);
      setImported(importedModules);
      setPersistedSettingsByAlias(settingsByAlias);
      setActionParamsJson(paramsByActionKey);
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

  const persistActionDraft = useCallback(
    async (
      moduleAlias: string,
      actionId: string,
      rawValue: string
    ): Promise<void> => {
      const nextAliasSettings = { ...(persistedSettingsByAlias[moduleAlias] ?? {}) };
      const trimmed = rawValue.trim();
      if (trimmed.length === 0) {
        delete nextAliasSettings[actionId];
      } else {
        nextAliasSettings[actionId] = trimmed;
      }
      const result = await window.pdv.modules.saveSettings({
        moduleAlias,
        values: nextAliasSettings,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Failed to save module settings");
      }
      setPersistedSettingsByAlias((prev) => ({
        ...prev,
        [moduleAlias]: nextAliasSettings,
      }));
    },
    [persistedSettingsByAlias]
  );

  const handlePersistActionDraft = async (
    moduleAlias: string,
    actionId: string
  ): Promise<void> => {
    const actionKey = `${moduleAlias}:${actionId}`;
    const rawValue = actionParamsJson[actionKey] ?? "";
    try {
      await persistActionDraft(moduleAlias, actionId, rawValue);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunAction = async (actionId: string): Promise<void> => {
    if (!selectedImported) return;
    if (!kernelId || !kernelReady) {
      setError("Start a ready kernel before running module actions.");
      return;
    }
    const actionKey = `${selectedImported.alias}:${actionId}`;
    setRunningActionKey(actionKey);
    setError(null);
    try {
      const rawArgs = (actionParamsJson[actionKey] ?? "").trim();
      await persistActionDraft(selectedImported.alias, actionId, rawArgs);
      const result = await window.pdv.modules.runAction({
        kernelId,
        moduleAlias: selectedImported.alias,
        actionId,
        rawArgs: rawArgs.length > 0 ? rawArgs : undefined,
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
                              id: {action.id} · script: {action.scriptName}
                            </div>
                          </div>
                          <input
                            className="modules-action-params"
                            type="text"
                            value={actionParamsJson[actionKey] ?? ""}
                            onChange={(event) =>
                              setActionParamsJson((prev) => ({
                                ...prev,
                                [actionKey]: event.target.value,
                              }))
                            }
                            onBlur={() =>
                              void handlePersistActionDraft(selectedImported.alias, action.id)
                            }
                            placeholder="value"
                            disabled={isRunning}
                          />
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
