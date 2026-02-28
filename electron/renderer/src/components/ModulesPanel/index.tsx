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
}

/**
 * Modules panel foundation UI for Feature 2 Step 7.
 */
export const ModulesPanel: React.FC<ModulesPanelProps> = ({
  projectDir,
  isActive,
  kernelId,
  kernelReady,
  onExecute,
  view,
}) => {
  const [installed, setInstalled] = useState<ModuleDescriptor[]>([]);
  const [imported, setImported] = useState<ImportedModuleDescriptor[]>([]);
  const [activeImportedAlias, setActiveImportedAlias] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const [runningActionKey, setRunningActionKey] = useState<string | null>(null);
  const [actionParamsJson, setActionParamsJson] = useState<Record<string, string>>({});
  const [installStatusByModuleId, setInstallStatusByModuleId] = useState<
    Record<string, ModuleInstallResult["status"]>
  >({});
  const [persistedSettingsByAlias, setPersistedSettingsByAlias] = useState<
    Record<string, Record<string, unknown>>
  >({});

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
            paramsByActionKey[`${moduleEntry.alias}:${action.id}`] = JSON.stringify(value);
          }
        }
      }
      setInstalled(installedModules);
      setInstallStatusByModuleId((previous) => {
        const next: Record<string, ModuleInstallResult["status"]> = {};
        for (const moduleEntry of installedModules) {
          const prior = previous[moduleEntry.id];
          if (prior) {
            next[moduleEntry.id] = prior;
          }
        }
        return next;
      });
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
  }, [isActive, refresh]);

  const selectedImported = useMemo(
    () => imported.find((entry) => entry.alias === activeImportedAlias) ?? null,
    [imported, activeImportedAlias]
  );

  const importedCountByModuleId = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const importedModule of imported) {
      counts[importedModule.moduleId] = (counts[importedModule.moduleId] ?? 0) + 1;
    }
    return counts;
  }, [imported]);

  const warningCountByModuleId = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const importedModule of imported) {
      if (importedModule.warnings.length === 0) continue;
      counts[importedModule.moduleId] =
        (counts[importedModule.moduleId] ?? 0) + importedModule.warnings.length;
    }
    return counts;
  }, [imported]);

  const handleInstallResult = async (result: ModuleInstallResult): Promise<void> => {
    if (!result.success && result.error) {
      setError(result.error);
    } else {
      setError(null);
    }
    const installedModuleId = result.module?.id;
    if (installedModuleId) {
      setInstallStatusByModuleId((previous) => ({
        ...previous,
        [installedModuleId]: result.status,
      }));
    }
    if (
      result.module &&
      (result.status === "update_available" || result.status === "incompatible_update")
    ) {
      const current = installed.find((entry) => entry.id === result.module?.id);
      const currentVersion = current?.version ?? "unknown";
      const availableVersion = result.module.version ?? "unknown";
      const currentRevision = current?.revision ? ` (${current.revision.slice(0, 8)})` : "";
      const availableRevision = result.module.revision
        ? ` (${result.module.revision.slice(0, 8)})`
        : "";
      window.confirm(
        `Module "${result.module.name}" already exists.\n\nCurrent: ${currentVersion}${currentRevision}\nAvailable: ${availableVersion}${availableRevision}\n\nPDV does not auto-apply updates yet; keep current installed version for now.`
      );
      setLastStatus(
        `Install status: ${result.status} · current ${currentVersion} vs available ${availableVersion}`
      );
    } else {
      setLastStatus(`Install status: ${result.status}`);
    }
    await refresh();
  };

  const handleInstallLocal = async (): Promise<void> => {
    const localPath = await window.pdv.files.pickDirectory();
    if (!localPath) return;
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
    const result = await window.pdv.modules.install({
      source: {
        type: "github",
        location: url.trim(),
      },
    });
    await handleInstallResult(result);
  };

  const handleImport = async (moduleId: string): Promise<void> => {
    if (!projectDir && !kernelReady) {
      setError("Start a kernel or open a project before importing modules.");
      return;
    }
    setError(null);
    const result = await window.pdv.modules.importToProject({ moduleId });
    if (result.status === "conflict" && result.suggestedAlias) {
      const shouldImportSuggested = window.confirm(
        `Module "${moduleId}" is already imported as "${result.alias ?? moduleId}".\nImport another copy as "${result.suggestedAlias}"?`
      );
      if (!shouldImportSuggested) {
        setLastStatus(`Import cancelled for "${moduleId}" due to alias conflict.`);
        return;
      }
      const retried = await window.pdv.modules.importToProject({
        moduleId,
        alias: result.suggestedAlias,
      });
      await handleImportResult(retried);
      return;
    }
    await handleImportResult(result);
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
      `Import status: ${result.status}${result.alias ? ` (${result.alias})` : ""}${warningSuffix}`
    );
    await refresh();
  };

  const parseActionParams = (rawParams: string): Record<string, unknown> => {
    const parsed = JSON.parse(rawParams) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Action parameters must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  };

  const persistActionParams = useCallback(
    async (
      moduleAlias: string,
      actionId: string,
      params: Record<string, unknown> | null
    ): Promise<void> => {
      const nextAliasSettings = { ...(persistedSettingsByAlias[moduleAlias] ?? {}) };
      if (params === null) {
        delete nextAliasSettings[actionId];
      } else {
        nextAliasSettings[actionId] = params;
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
    const rawParams = (actionParamsJson[actionKey] ?? "").trim();
    try {
      if (rawParams.length === 0) {
        await persistActionParams(moduleAlias, actionId, null);
      } else {
        await persistActionParams(moduleAlias, actionId, parseActionParams(rawParams));
      }
      setError(null);
      setLastStatus(`Settings saved: ${moduleAlias}.${actionId}`);
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
      const rawParams = (actionParamsJson[actionKey] ?? "").trim();
      let params: Record<string, unknown> = {};
      if (rawParams.length > 0) {
        params = parseActionParams(rawParams);
      }
      await persistActionParams(selectedImported.alias, actionId, params);
      const result = await window.pdv.modules.runAction({
        kernelId,
        moduleAlias: selectedImported.alias,
        actionId,
        params,
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

  return (
    <div className="modules-panel">
      {view === 'library' && <div className="modules-library">
        <div className="modules-library-header">
          <strong>Library</strong>
          <div className="modules-library-actions">
            <button className="btn btn-secondary" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => void handleInstallLocal()}
              disabled={loading}
            >
              Install Local
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => void handleInstallGithub()}
              disabled={loading}
            >
              Install GitHub
            </button>
          </div>
        </div>
        {!projectDir && (
          <div className="modules-inline-note">
            Imports go to the active working project; save later to persist to a chosen folder.
          </div>
        )}
        {loading && <div className="modules-inline-note">Loading modules…</div>}
        {error && <div className="modules-error">{error}</div>}
        {lastStatus && <div className="modules-inline-note">{lastStatus}</div>}
        {installed.length === 0 ? (
          <div className="modules-inline-note">No installed modules.</div>
        ) : (
          <ul className="modules-list">
            {installed.map((entry) => (
              <li key={entry.id} className="modules-list-item">
                <div>
                  <div className="modules-name">{entry.name}</div>
                  <div className="modules-meta">
                    {entry.id} · v{entry.version}
                  </div>
                  <div className="modules-badges">
                    <span className="modules-badge modules-badge-installed">installed</span>
                    {(importedCountByModuleId[entry.id] ?? 0) > 0 && (
                      <span className="modules-badge modules-badge-imported">
                        imported
                        {importedCountByModuleId[entry.id] > 1
                          ? ` ×${importedCountByModuleId[entry.id]}`
                          : ""}
                      </span>
                    )}
                    {(warningCountByModuleId[entry.id] ?? 0) > 0 && (
                      <span className="modules-badge modules-badge-warning">
                        warning
                        {warningCountByModuleId[entry.id] > 1
                          ? ` ×${warningCountByModuleId[entry.id]}`
                          : ""}
                      </span>
                    )}
                    {installStatusByModuleId[entry.id] === "update_available" && (
                      <span className="modules-badge modules-badge-update">update available</span>
                    )}
                    {installStatusByModuleId[entry.id] === "incompatible_update" && (
                      <span className="modules-badge modules-badge-update">incompatible update</span>
                    )}
                  </div>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => void handleImport(entry.id)}
                  disabled={loading || (!projectDir && !kernelReady)}
                >
                  {(importedCountByModuleId[entry.id] ?? 0) > 0 ? "Import Again" : "Import"}
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
                            placeholder='{"param": 1}'
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
