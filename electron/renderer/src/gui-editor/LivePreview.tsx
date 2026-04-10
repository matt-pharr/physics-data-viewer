/**
 * LivePreview.tsx — Functional live preview of the GUI being edited.
 *
 * Renders the current manifest using the existing ContainerRenderer,
 * providing local input state for interactive testing. Actions are
 * displayed but not executable from the preview (kernel context is
 * not available for arbitrary script paths in the editor).
 */

import { useState, useCallback } from "react";
import type {
  ImportedModuleActionDescriptor,
  ModuleInputDescriptor,
} from "../types/pdv.d";
import { ContainerRenderer } from "../components/ModuleGui/ContainerRenderer";
import { useEditorState } from "./editor-state";

type ModuleInputValue = string | number | boolean;

const PREVIEW_ALIAS = "__editor_preview__";

/**
 * Adapt GuiActionDescriptors to ImportedModuleActionDescriptors
 * for ContainerRenderer compatibility.
 */
function adaptActions(
  actions: { id: string; label: string; script_path: string; inputs?: string[] }[]
): ImportedModuleActionDescriptor[] {
  return actions.map((a) => ({
    id: a.id,
    label: a.label,
    scriptName: a.script_path,
    inputIds: a.inputs,
  }));
}

export function LivePreview() {
  const state = useEditorState();
  const { manifest } = state;
  const layout = manifest.gui?.layout;

  const [inputValues, setInputValues] = useState<Record<string, ModuleInputValue>>({});
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({});

  const setModuleInputValue = useCallback(
    (_alias: string, inputId: string, value: ModuleInputValue) => {
      setInputValues((prev) => ({ ...prev, [`${PREVIEW_ALIAS}:${inputId}`]: value }));
    },
    []
  );

  const persistInputValues = useCallback(async (_alias: string) => {
    // No-op in preview
  }, []);

  const isInputVisible = useCallback(
    (_alias: string, input: ModuleInputDescriptor) => {
      if (!input.visibleIf) return true;
      const key = `${PREVIEW_ALIAS}:${input.visibleIf.inputId}`;
      return inputValues[key] === input.visibleIf.equals;
    },
    [inputValues]
  );

  const handleSetSectionOpen = useCallback(
    async (_alias: string, tabName: string, sectionName: string, isOpen: boolean) => {
      const key = `${tabName}::${sectionName}`;
      setSectionOpen((prev) => ({ ...prev, [key]: isOpen }));
    },
    []
  );

  const handleRunAction = useCallback(async (_actionId: string) => {
    // Actions are visible but disabled in preview mode
  }, []);

  const handleError = useCallback((_msg: string) => {
    // Swallow errors in preview
  }, []);

  if (!layout || layout.children.length === 0) {
    return (
      <div className="gui-editor-preview">
        <div className="gui-editor-preview-header">Live Preview</div>
        <div className="gui-editor-preview-empty">
          Drag elements from the palette to build your GUI
        </div>
      </div>
    );
  }

  // Initialize defaults for inputs that don't have values yet
  const effectiveValues = { ...inputValues };
  for (const input of manifest.inputs) {
    const key = `${PREVIEW_ALIAS}:${input.id}`;
    if (!(key in effectiveValues) && input.default != null) {
      effectiveValues[key] = input.default;
    }
  }

  return (
    <div className="gui-editor-preview">
      <div className="gui-editor-preview-header">Live Preview</div>
      <div className="gui-editor-preview-body">
        <ContainerRenderer
          node={layout}
          moduleAlias={PREVIEW_ALIAS}
          inputs={manifest.inputs}
          actions={adaptActions(manifest.actions)}
          inputValues={effectiveValues}
          sectionOpen={sectionOpen}
          runningActionKey={null}
          kernelReady={false}
          kernelId={null}
          isInputVisible={isInputVisible}
          setModuleInputValue={setModuleInputValue}
          persistInputValues={persistInputValues}
          setSectionOpenState={handleSetSectionOpen}
          onRunAction={handleRunAction}
          onError={handleError}
        />
      </div>
    </div>
  );
}
