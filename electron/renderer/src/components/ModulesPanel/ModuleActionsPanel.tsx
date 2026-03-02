import React from "react";

import type { ImportedModuleDescriptor } from "../../types";
import { getActionTabName } from "./moduleUiHelpers";

interface ModuleActionsPanelProps {
  moduleAlias: string;
  actions: ImportedModuleDescriptor["actions"];
  activeTab: string;
  runningActionKey: string | null;
  kernelReady: boolean;
  kernelId: string | null;
  onRunAction: (actionId: string) => Promise<void>;
}

/** Render module actions filtered by the currently selected module tab. */
export const ModuleActionsPanel: React.FC<ModuleActionsPanelProps> = ({
  moduleAlias,
  actions,
  activeTab,
  runningActionKey,
  kernelReady,
  kernelId,
  onRunAction,
}) => {
  if (actions.length === 0) {
    return <div className="modules-inline-note">This module defines no actions.</div>;
  }

  const visibleActions = actions.filter((action) => getActionTabName(action) === activeTab);

  return (
    <div className="modules-actions">
      {visibleActions.map((action) => {
        const actionKey = `${moduleAlias}:${action.id}`;
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
              onClick={() => void onRunAction(action.id)}
              disabled={isRunning || !kernelReady || !kernelId}
            >
              {isRunning ? "Running..." : "Run"}
            </button>
          </div>
        );
      })}
      {visibleActions.length === 0 && (
        <div className="modules-inline-note">No actions in this tab.</div>
      )}
    </div>
  );
};
