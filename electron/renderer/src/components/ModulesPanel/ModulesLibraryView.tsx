import React from "react";
import type { ModuleDescriptor } from "../../types";
import type { ImportConflict, InstallDuplicate } from "./moduleUiHelpers";

interface ModulesLibraryViewProps {
  projectDir: string | null;
  loading: boolean;
  error: string | null;
  lastStatus: string | null;
  installDuplicate: InstallDuplicate | null;
  importConflict: ImportConflict | null;
  installed: ModuleDescriptor[];
  importedModuleIds: Set<string>;
  warningCountByModuleId: Map<string, number>;
  onRefresh: () => Promise<void>;
  onInstallLocal: () => Promise<void>;
  onInstallGithub: () => Promise<void>;
  onDismissInstallDuplicate: () => void;
  onConflictAccept: () => Promise<void>;
  onConflictCancel: () => void;
  onImport: (moduleId: string) => Promise<void>;
}

export const ModulesLibraryView: React.FC<ModulesLibraryViewProps> = ({
  projectDir,
  loading,
  error,
  lastStatus,
  installDuplicate,
  importConflict,
  installed,
  importedModuleIds,
  warningCountByModuleId,
  onRefresh,
  onInstallLocal,
  onInstallGithub,
  onDismissInstallDuplicate,
  onConflictAccept,
  onConflictCancel,
  onImport,
}) => {
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

  const formatVersionLabel = (version: string, revision?: string): string => {
    if (revision) {
      return `v${version} (${revision.slice(0, 8)})`;
    }
    return `v${version}`;
  };

  return (
    <div className="modules-library">
      <div className="modules-library-header">
        <strong>Library</strong>
        <div className="modules-library-actions">
          <button className="btn btn-secondary" onClick={() => void onRefresh()} disabled={loading}>Refresh</button>
          <button className="btn btn-secondary" onClick={() => void onInstallLocal()} disabled={loading}>Install Local</button>
          <button className="btn btn-secondary" onClick={() => void onInstallGithub()} disabled={loading}>Install GitHub</button>
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
            <button className="btn btn-secondary" onClick={onDismissInstallDuplicate}>
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
            <button className="btn btn-primary" onClick={() => void onConflictAccept()}>
              Import as "{importConflict.suggestedAlias}"
            </button>
            <button className="btn btn-secondary" onClick={onConflictCancel}>
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
                onClick={() => void onImport(entry.id)}
                disabled={loading}
              >
                Import
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
