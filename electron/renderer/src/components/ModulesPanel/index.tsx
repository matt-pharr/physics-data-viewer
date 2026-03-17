import React, { useCallback, useEffect, useState } from "react";
import type {
  ImportedModuleDescriptor,
  ModuleDescriptor,
  ModuleImportResult,
  ModuleInstallResult,
} from "../../types";
import { ImportedModulesView } from "./ImportedModulesView";
import { ModulesLibraryView } from "./ModulesLibraryView";
import {
  type ImportConflict,
  type InstallDuplicate,
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
 * Modules panel UI — simplified for multi-window popup GUIs.
 *
 * The `imported` view now shows a compact list with double-click to open
 * module GUIs in popup windows. Input/action state management has moved to
 * the ModuleWindowRoot component in each popup.
 */
export const ModulesPanel: React.FC<ModulesPanelProps> = ({
  projectDir,
  isActive,
  kernelId,
  kernelReady: _kernelReady,
  onExecute: _onExecute,
  view,
  refreshToken,
}) => {
  const [installed, setInstalled] = useState<ModuleDescriptor[]>([]);
  const [imported, setImported] = useState<ImportedModuleDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);

  // Step 11: in-panel prompts for import conflicts and install duplicates.
  const [importConflict, setImportConflict] = useState<ImportConflict | null>(null);
  const [installDuplicate, setInstallDuplicate] = useState<InstallDuplicate | null>(null);

  // Compute which module IDs are already imported in the active project.
  const importedModuleIds = React.useMemo(
    () => new Set(imported.map((entry) => entry.moduleId)),
    [imported]
  );

  // Compute warning counts per installed module ID (from imported warnings).
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
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh, refreshToken, kernelId]);

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
    setLastStatus(
      `Imported${result.alias ? ` as "${result.alias}"` : ""}${warningSuffix}`
    );
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
          kernelId={kernelId}
          onRemoveImport={handleRemoveImport}
        />
      )}
    </div>
  );
};
