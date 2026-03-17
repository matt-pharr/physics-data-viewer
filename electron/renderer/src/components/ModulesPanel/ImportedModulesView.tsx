import React from "react";
import type { ImportedModuleDescriptor } from "../../types";

interface ImportedModulesViewProps {
  imported: ImportedModuleDescriptor[];
  kernelId: string | null;
  onRemoveImport: (alias: string) => Promise<void>;
}

export const ImportedModulesView: React.FC<ImportedModulesViewProps> = ({
  imported,
  kernelId,
  onRemoveImport,
}) => {
  const handleDoubleClick = (entry: ImportedModuleDescriptor) => {
    if (!kernelId || !entry.hasGui) return;
    void window.pdv.moduleWindows.open({ alias: entry.alias, kernelId });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div className="modules-imported">
      <div className="modules-imported-header">
        <strong>Imported Modules</strong>
      </div>
      {imported.length === 0 ? (
        <div className="modules-inline-note">No modules imported in this project.</div>
      ) : (
        <div className="modules-imported-list">
          {imported.filter((entry) => entry.hasGui).map((entry) => (
            <div
              key={entry.alias}
              className="modules-imported-row"
              onDoubleClick={() => handleDoubleClick(entry)}
              onContextMenu={handleContextMenu}
              title={`Double-click to open GUI${entry.hasGui ? "" : " (no GUI)"}`}
            >
              <div className="modules-imported-row-info">
                <span className="modules-imported-row-name">{entry.name}</span>
                <span className="modules-imported-row-version">v{entry.version}</span>
                {entry.warnings.length > 0 && (
                  <span className="modules-warning-badge" title={entry.warnings.map((w) => w.message).join("\n")}>
                    {entry.warnings.length}
                  </span>
                )}
              </div>
              <div className="modules-imported-row-actions">
                <button
                  className="modules-imported-row-open-btn"
                  onClick={() => handleDoubleClick(entry)}
                  disabled={!kernelId || !entry.hasGui}
                  title="Open module GUI"
                >
                  Open
                </button>
                <button
                  className="modules-imported-row-remove-btn"
                  onClick={() => void onRemoveImport(entry.alias)}
                  title="Remove import"
                >
                  &times;
                </button>
              </div>
            </div>
          ))}
          {imported.filter((entry) => !entry.hasGui).length > 0 && (
            <div className="modules-inline-note" style={{ marginTop: 8 }}>
              {imported.filter((entry) => !entry.hasGui).length} module(s) without GUI imported
            </div>
          )}
        </div>
      )}
    </div>
  );
};
