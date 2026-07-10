/**
 * gui-host-utils.ts — Shared helpers for the three GUI hosts.
 *
 * ModuleWindowRoot, GuiViewerRoot, and the editor's LivePreview all render
 * GUI layouts through ContainerRenderer but had drifted copies of the glue:
 * the GuiActionDescriptor → ImportedModuleActionDescriptor adapter and the
 * tree-backed dropdown resolution (which GuiViewerRoot lacked entirely,
 * leaving its dropdowns empty). Both now live here.
 */

import type {
  GuiActionDescriptor,
  ImportedModuleActionDescriptor,
} from "../../types/pdv";
import type { ModuleInputDescriptor } from "../ModulesPanel/moduleUiHelpers";
import { treeService } from "../../services/tree";

/**
 * Adapt manifest {@link GuiActionDescriptor}s (snake_case, from gui.json)
 * to the {@link ImportedModuleActionDescriptor} shape ContainerRenderer
 * expects.
 */
export function adaptGuiActions(
  actions: GuiActionDescriptor[],
): ImportedModuleActionDescriptor[] {
  return actions.map((a) => ({
    id: a.id,
    label: a.label,
    scriptName: a.script_path,
    inputIds: a.inputs,
  }));
}

/**
 * Resolve tree-backed dropdown options: for every dropdown input carrying
 * an `optionsTreePath`, list that tree path's children and use their keys
 * as the options. Inputs without the binding pass through untouched; a
 * bound input whose path is blank resolves to an empty option list.
 *
 * @param inputs - Input descriptors from a module or GUI manifest.
 * @param kernelId - Kernel to query. `null` leaves bound dropdowns empty.
 * @returns A new array with bound dropdowns' `options` populated.
 */
export async function resolveTreeDropdownOptions<T extends ModuleInputDescriptor>(
  inputs: T[],
  kernelId: string | null,
): Promise<T[]> {
  return Promise.all(
    inputs.map(async (input) => {
      if (input.control !== "dropdown" || !input.optionsTreePath) {
        return input;
      }
      const treePath = input.optionsTreePath.trim();
      if (!treePath) return { ...input, options: [] };
      const nodes = await treeService.listByPath(kernelId, treePath);
      return {
        ...input,
        options: nodes.map((node) => ({ label: node.key, value: node.key })),
      };
    }),
  );
}
