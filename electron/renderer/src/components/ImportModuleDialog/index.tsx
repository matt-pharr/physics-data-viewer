import React, { useCallback, useEffect, useState } from "react";
import type {
  ImportedModuleDescriptor,
  ModuleDescriptor,
  ModuleImportResult,
  ModuleInstallResult,
} from "../../types";
import {
  type ImportConflict,
  type InstallDuplicate,
} from "../ModulesPanel/moduleUiHelpers";

interface ImportModuleDialogProps {
  isOpen: boolean;
  projectDir: string | null;
  kernelReady: boolean;
  refreshToken?: number;
  onClose: () => void;
}

export const ImportModuleDialog: React.FC<ImportModuleDialogProps> = ({
  isOpen,
  projectDir,
  kernelReady,
  refreshToken,
  onClose,
}) => {
  const [installed, setInstalled] = useState<ModuleDescriptor[]>([]);
  const [imported, setImported] = useState<ImportedModuleDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  const [importConflict, setImportConflict] = useState<ImportConflict | null>(null);
  const [installDuplicate, setInstallDuplicate] = useState<InstallDuplicate | null>(null);

  const importedModuleIds = React.useMemo(
    () => new Set(imported.map((entry) => entry.moduleId)),
    [imported]
  );

  const warningCountByModuleId = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of imported) {
      if (entry.warnings.length > 0) {
        counts.set(entry.moduleId, (counts.get(entry.moduleId) ?? 0) + entry.warnings.length);
      }
    }
    return counts;
  }, [imported]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [installedModules, importedModules] = await Promise.all([
        window.pdv.modules.listInstalled(),
        window.pdv.modules.listImported(),
      ]);
      setInstalled(installedModules);
      setImported(importedModules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
  }, [isOpen, refresh, refreshToken]);

  const handleInstallResult = async (result: ModuleInstallResult): Promise<void> => {
    if (!result.success && result.error) {
      setError(result.error);
      setLastStatus(null);
      return;
    }
    setError(null);

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
      source: { type: "local", location: localPath },
    });
    await handleInstallResult(result);
  };

  const handleInstallGithub = async (): Promise<void> => {
    const url = window.prompt("GitHub repository URL");
    if (!url || !url.trim()) return;
    setInstallDuplicate(null);
    const result = await window.pdv.modules.install({
      source: { type: "github", location: url.trim() },
    });
    await handleInstallResult(result);
  };

  const handleImport = async (moduleId: string): Promise<void> => {
    setError(null);
    setImportConflict(null);
    const result = await window.pdv.modules.importToProject({ moduleId });
    if (result.status === "conflict" && result.suggestedAlias) {
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
    if (result.success) {
      setLastStatus(
        `Imported${result.alias ? ` as "${result.alias}"` : ""}${warningSuffix}`
      );
    } else if (!result.error) {
      setLastStatus("Import failed.");
    }
    await refresh();
  };

  const handleRemoveImport = async (alias: string): Promise<void> => {
    const result = await window.pdv.modules.removeImport(alias);
    if (!result.success && result.error) {
      setError(result.error);
    } else {
      setError(null);
      setLastStatus(`Removed: ${alias}`);
    }
    await refresh();
  };

  const formatVersionLabel = (version: string, revision?: string): string => {
    if (revision) {
      return `v${version} (${revision.slice(0, 8)})`;
    }
    return `v${version}`;
  };

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

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="import-module-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Import Module</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
          <div className="import-module-actions">
            <button className="btn btn-secondary" onClick={() => void refresh()} disabled={loading}>Refresh</button>
            <button className="btn btn-secondary" onClick={() => void handleInstallLocal()} disabled={loading}>Install Local</button>
            <button className="btn btn-secondary" onClick={() => void handleInstallGithub()} disabled={loading}>Install GitHub</button>
          </div>

          {!projectDir && (
            <div className="modules-inline-note">
              Imported modules will be saved when the project is saved.
            </div>
          )}
          {loading && <div className="modules-inline-note">Loading modules...</div>}
          {error && <div className="modules-error">{error}</div>}
          {lastStatus && <div className="modules-inline-note">{lastStatus}</div>}

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

          {/* Imported modules section */}
          {imported.length > 0 && (
            <div className="import-module-section">
              <div className="import-module-section-header">Imported</div>
              <ul className="modules-list">
                {imported.map((entry) => (
                  <li key={entry.alias} className="modules-list-item">
                    <div>
                      <div className="modules-name">
                        {entry.name}
                        <span className="modules-badge-group">
                          <span className="modules-status-badge modules-badge-imported">
                            {entry.alias}
                          </span>
                          {entry.hasGui && (
                            <span className="modules-status-badge modules-badge-gui">GUI</span>
                          )}
                        </span>
                      </div>
                      <div className="modules-meta">
                        v{entry.version}
                      </div>
                    </div>
                    <button
                      className="btn btn-secondary btn-danger-text"
                      onClick={() => void handleRemoveImport(entry.alias)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Installed modules (library) section */}
          <div className="import-module-section">
            <div className="import-module-section-header">Library</div>
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
          </div>
        </div>
      </div>
    </div>
  );
};
