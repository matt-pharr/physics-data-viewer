/**
 * ActionButton.tsx — Renders a single module action button.
 *
 * Extracted from ModuleActionsPanel for reuse in the container layout renderer.
 */

import React from "react";
import type { ImportedModuleActionDescriptor } from "../../types/pdv";

interface ActionButtonProps {
  moduleAlias: string;
  action: ImportedModuleActionDescriptor;
  runningActionKey: string | null;
  kernelReady: boolean;
  kernelId: string | null;
  onRunAction: (actionId: string) => Promise<void>;
}

export const ActionButton: React.FC<ActionButtonProps> = ({
  moduleAlias,
  action,
  runningActionKey,
  kernelReady,
  kernelId,
  onRunAction,
}) => {
  const actionKey = `${moduleAlias}:${action.id}`;
  const isRunning = runningActionKey === actionKey;

  return (
    <div className="modules-action-row">
      <div className="modules-action-meta">
        <div className="modules-name">{action.label}</div>
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
};
