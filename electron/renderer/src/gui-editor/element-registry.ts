/**
 * element-registry.ts — Element type definitions for the GUI editor palette.
 *
 * Each entry describes one draggable element type: its category, display info,
 * and a factory that produces the default LayoutNode (and optionally a new
 * input/action descriptor) when dropped onto the canvas.
 *
 * To add a new GUI element type, add one entry to ELEMENT_REGISTRY.
 */

import type {
  LayoutNode,
  ModuleInputDescriptor,
  GuiActionDescriptor,
  GuiManifestV1,
} from "../types/pdv.d";

export interface ElementTypeDefinition {
  /** LayoutNode type string (e.g., "input", "row"). */
  type: string;
  /** Whether this element can contain children. */
  category: "container" | "leaf";
  /** Display label in the palette. */
  label: string;
  /** One-line description shown in the palette. */
  description: string;
  /** Short icon text displayed in the palette icon box. */
  icon: string;
  /** Factory: given the current manifest, produces a new node and optional descriptors. */
  factory: (manifest: GuiManifestV1) => {
    node: LayoutNode;
    input?: ModuleInputDescriptor;
    action?: GuiActionDescriptor;
  };
}

/**
 * Generate a unique ID by appending an incrementing suffix.
 */
function generateId(prefix: string, existingIds: Set<string>): string {
  let n = 1;
  while (existingIds.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

/** Collect all existing input and action IDs from a manifest. */
function allIds(manifest: GuiManifestV1): Set<string> {
  const ids = new Set<string>();
  for (const inp of manifest.inputs) ids.add(inp.id);
  for (const act of manifest.actions) ids.add(act.id);
  return ids;
}

export const ELEMENT_REGISTRY: ElementTypeDefinition[] = [
  // ── Containers ──
  {
    type: "column",
    category: "container",
    label: "Column",
    description: "Stack elements vertically",
    icon: "\u2503",
    factory: () => ({
      node: { type: "column", children: [] },
    }),
  },
  {
    type: "row",
    category: "container",
    label: "Row",
    description: "Arrange elements side by side",
    icon: "\u2501",
    factory: () => ({
      node: { type: "row", children: [] },
    }),
  },
  {
    type: "group",
    category: "container",
    label: "Group",
    description: "Collapsible section with a label",
    icon: "\u25BC",
    factory: () => ({
      node: { type: "group", label: "New Group", children: [] },
    }),
  },
  {
    type: "tabs",
    category: "container",
    label: "Tabs",
    description: "Tabbed container for organizing content",
    icon: "\u2630",
    factory: () => ({
      node: {
        type: "tabs",
        children: [
          { type: "column", label: "Tab 1", children: [] },
        ],
      },
    }),
  },

  // ── Leaves ──
  {
    type: "input",
    category: "leaf",
    label: "Input",
    description: "User input (text, slider, dropdown, checkbox, file)",
    icon: "i",
    factory: (manifest) => {
      const id = generateId("input", allIds(manifest));
      return {
        node: { type: "input", id },
        input: { id, label: "New Input", control: "text" },
      };
    },
  },
  {
    type: "action",
    category: "leaf",
    label: "Action Button",
    description: "Button that runs a script",
    icon: "\u25B6",
    factory: (manifest) => {
      const id = generateId("action", allIds(manifest));
      return {
        node: { type: "action", id },
        action: { id, label: "New Action", script_path: "", inputs: [] },
      };
    },
  },
  {
    type: "namelist",
    category: "leaf",
    label: "Namelist Editor",
    description: "Inline editor for namelist files in the tree",
    icon: "N",
    factory: () => ({
      node: { type: "namelist", tree_path: "" },
    }),
  },
];

/** Look up a registry entry by its type string. */
export function getElementDef(type: string): ElementTypeDefinition | undefined {
  return ELEMENT_REGISTRY.find((e) => e.type === type);
}
