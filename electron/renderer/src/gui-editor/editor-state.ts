/**
 * editor-state.ts — State management for the GUI editor.
 *
 * Uses React Context + useReducer. The state holds the in-memory manifest,
 * selected node path, and dirty flag. All mutations go through the reducer
 * so the live preview and property editor stay in sync.
 */

import React, { createContext, useContext, useReducer, type Dispatch } from "react";
import type {
  GuiManifestV1,
  LayoutNode,
  LayoutContainer,
  ModuleInputDescriptor,
  GuiActionDescriptor,
} from "../types/pdv.d";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface EditorState {
  manifest: GuiManifestV1;
  /** Index-path string of the selected node, e.g. "0", "0.2.1". */
  selectedNodePath: string | null;
  dirty: boolean;
  treePath: string;
  kernelId: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type EditorAction =
  | { type: "LOAD_MANIFEST"; manifest: GuiManifestV1; treePath: string; kernelId: string }
  | { type: "SELECT_NODE"; path: string | null }
  | { type: "ADD_NODE"; parentPath: string; index: number; node: LayoutNode; input?: ModuleInputDescriptor; action?: GuiActionDescriptor }
  | { type: "MOVE_NODE"; fromPath: string; toParentPath: string; toIndex: number }
  | { type: "DELETE_NODE"; path: string }
  | { type: "UPDATE_NODE"; path: string; updates: Partial<LayoutContainer> }
  | { type: "UPDATE_INPUT"; id: string; updates: Partial<ModuleInputDescriptor> }
  | { type: "UPDATE_ACTION"; id: string; updates: Partial<GuiActionDescriptor> }
  | { type: "UPDATE_NAMELIST"; path: string; updates: { tree_path?: string; tree_path_input?: string } }
  | { type: "MARK_CLEAN" };

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Parse a path string like "0.2.1" into an array of indices. */
function parsePath(p: string): number[] {
  if (!p) return [];
  return p.split(".").map(Number);
}

/** Get a layout node by its index path. */
export function getNodeAtPath(layout: LayoutContainer, pathStr: string): LayoutNode | null {
  const indices = parsePath(pathStr);
  let current: LayoutNode = layout;
  for (const idx of indices) {
    if (!("children" in current)) return null;
    const container = current as LayoutContainer;
    if (idx < 0 || idx >= container.children.length) return null;
    current = container.children[idx];
  }
  return current;
}

/** Deep clone a layout container tree (plain JSON, no class instances). */
function cloneLayout(layout: LayoutContainer): LayoutContainer {
  return JSON.parse(JSON.stringify(layout));
}

/** Get the parent container and child index for a given path. */
function getParentAndIndex(
  layout: LayoutContainer,
  pathStr: string
): { parent: LayoutContainer; index: number } | null {
  const indices = parsePath(pathStr);
  if (indices.length === 0) return null;
  const childIndex = indices[indices.length - 1];
  const parentIndices = indices.slice(0, -1);

  let parent: LayoutNode = layout;
  for (const idx of parentIndices) {
    if (!("children" in parent)) return null;
    parent = (parent as LayoutContainer).children[idx];
  }
  if (!("children" in parent)) return null;
  return { parent: parent as LayoutContainer, index: childIndex };
}

/** Insert a node at the specified parent path and index. */
function insertNode(layout: LayoutContainer, parentPath: string, index: number, node: LayoutNode): LayoutContainer {
  const newLayout = cloneLayout(layout);
  const parentIndices = parsePath(parentPath);

  let parent: LayoutNode = newLayout;
  for (const idx of parentIndices) {
    parent = (parent as LayoutContainer).children[idx];
  }
  if (!("children" in parent)) return layout;
  (parent as LayoutContainer).children.splice(index, 0, JSON.parse(JSON.stringify(node)));
  return newLayout;
}

/** Remove a node at the given path, returning [newLayout, removedNode]. */
function removeNode(layout: LayoutContainer, pathStr: string): [LayoutContainer, LayoutNode | null] {
  const result = getParentAndIndex(layout, pathStr);
  if (!result) return [layout, null];
  const newLayout = cloneLayout(layout);
  const newResult = getParentAndIndex(newLayout, pathStr)!;
  const removed = newResult.parent.children.splice(newResult.index, 1)[0];
  return [newLayout, removed];
}

/**
 * Adjust a target path after a node has been removed from `removedPath`.
 * If the target would shift because of the removal, adjusts accordingly.
 */
function adjustPathAfterRemoval(targetParent: string, targetIndex: number, removedPath: string): { parentPath: string; index: number } {
  const removedIndices = parsePath(removedPath);
  const targetParentIndices = parsePath(targetParent);

  // Adjust ancestor indices in the target parent path.
  // At each depth level, if the removed node is a sibling of the target's
  // ancestor at that level (same parent prefix) and comes before it, we
  // must decrement the target ancestor index at that level.
  const adjustedParentIndices = [...targetParentIndices];
  for (let depth = 0; depth < adjustedParentIndices.length; depth++) {
    // The removed node must be at this depth (length = depth + 1) to be
    // a sibling of the target's ancestor at this depth.
    if (removedIndices.length !== depth + 1) continue;
    // Check that the parents above this depth are the same
    const sameAncestors = removedIndices.slice(0, depth).every(
      (v, i) => v === targetParentIndices[i],
    );
    if (sameAncestors && removedIndices[depth] < adjustedParentIndices[depth]) {
      adjustedParentIndices[depth]--;
    }
  }

  // Adjust the target index itself: the removed node must be a direct child
  // of the (adjusted) target parent.
  let adjustedIndex = targetIndex;
  if (removedIndices.length === adjustedParentIndices.length + 1) {
    const sameParent = removedIndices.slice(0, -1).every(
      (v, i) => v === adjustedParentIndices[i],
    );
    if (sameParent && removedIndices[removedIndices.length - 1] < targetIndex) {
      adjustedIndex--;
    }
  }

  const adjustedParentPath = adjustedParentIndices.join('.');
  return { parentPath: adjustedParentPath, index: adjustedIndex };
}

/** Recursively collect all input and action IDs from a subtree. */
function collectLeafIds(node: LayoutNode): { inputIds: string[]; actionIds: string[] } {
  const inputIds: string[] = [];
  const actionIds: string[] = [];
  if (node.type === "input" && "id" in node) {
    inputIds.push((node as { id: string }).id);
  } else if (node.type === "action" && "id" in node) {
    actionIds.push((node as { id: string }).id);
  }
  if ("children" in node) {
    for (const child of (node as LayoutContainer).children) {
      const sub = collectLeafIds(child);
      inputIds.push(...sub.inputIds);
      actionIds.push(...sub.actionIds);
    }
  }
  return { inputIds, actionIds };
}

/** Walk the layout tree and rename all input refs with the given old ID. */
function renameLayoutInputRef(layout: LayoutContainer, oldId: string, newId: string): LayoutContainer {
  const newLayout = cloneLayout(layout);
  function walk(node: LayoutNode): void {
    if (node.type === "input" && "id" in node && (node as { id: string }).id === oldId) {
      (node as { id: string }).id = newId;
    }
    if ("children" in node) {
      for (const child of (node as LayoutContainer).children) walk(child);
    }
  }
  walk(newLayout);
  return newLayout;
}

/** Walk the layout tree and rename all action refs with the given old ID. */
function renameLayoutActionRef(layout: LayoutContainer, oldId: string, newId: string): LayoutContainer {
  const newLayout = cloneLayout(layout);
  function walk(node: LayoutNode): void {
    if (node.type === "action" && "id" in node && (node as { id: string }).id === oldId) {
      (node as { id: string }).id = newId;
    }
    if ("children" in node) {
      for (const child of (node as LayoutContainer).children) walk(child);
    }
  }
  walk(newLayout);
  return newLayout;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "LOAD_MANIFEST":
      return {
        manifest: action.manifest,
        selectedNodePath: null,
        dirty: false,
        treePath: action.treePath,
        kernelId: action.kernelId,
      };

    case "SELECT_NODE":
      return { ...state, selectedNodePath: action.path };

    case "ADD_NODE": {
      const layout = state.manifest.gui?.layout;
      if (!layout) return state;
      const newLayout = insertNode(layout, action.parentPath, action.index, action.node);
      const newInputs = action.input
        ? [...state.manifest.inputs, action.input]
        : state.manifest.inputs;
      const newActions = action.action
        ? [...state.manifest.actions, action.action]
        : state.manifest.actions;
      return {
        ...state,
        dirty: true,
        manifest: {
          ...state.manifest,
          gui: { layout: newLayout },
          inputs: newInputs,
          actions: newActions,
        },
      };
    }

    case "MOVE_NODE": {
      const layout = state.manifest.gui?.layout;
      if (!layout) return state;
      const [afterRemove, removed] = removeNode(layout, action.fromPath);
      if (!removed) return state;
      const adjusted = adjustPathAfterRemoval(action.toParentPath, action.toIndex, action.fromPath);
      const newLayout = insertNode(afterRemove, adjusted.parentPath, adjusted.index, removed);
      return {
        ...state,
        dirty: true,
        selectedNodePath: null,
        manifest: { ...state.manifest, gui: { layout: newLayout } },
      };
    }

    case "DELETE_NODE": {
      const layout = state.manifest.gui?.layout;
      if (!layout) return state;

      // Collect all input/action IDs in the subtree before removing
      const nodeToDelete = getNodeAtPath(layout, action.path);
      const { inputIds, actionIds } = nodeToDelete ? collectLeafIds(nodeToDelete) : { inputIds: [], actionIds: [] };
      const [newLayout] = removeNode(layout, action.path);

      const inputIdSet = new Set(inputIds);
      const actionIdSet = new Set(actionIds);
      const newInputs = state.manifest.inputs.filter((inp) => !inputIdSet.has(inp.id));
      const newActions = state.manifest.actions.filter((act) => !actionIdSet.has(act.id));

      return {
        ...state,
        dirty: true,
        selectedNodePath: null,
        manifest: {
          ...state.manifest,
          gui: { layout: newLayout },
          inputs: newInputs,
          actions: newActions,
        },
      };
    }

    case "UPDATE_NODE": {
      const layout = state.manifest.gui?.layout;
      if (!layout) return state;
      const newLayout = cloneLayout(layout);
      const node = getNodeAtPath(newLayout, action.path);
      if (!node || !("children" in node)) return state;
      Object.assign(node, action.updates);
      return {
        ...state,
        dirty: true,
        manifest: { ...state.manifest, gui: { layout: newLayout } },
      };
    }

    case "UPDATE_INPUT": {
      const newInputs = state.manifest.inputs.map((inp) =>
        inp.id === action.id ? { ...inp, ...action.updates } : inp
      );
      let newLayout = state.manifest.gui?.layout;
      let newActions = state.manifest.actions;
      // If ID was changed, update layout refs and action input bindings
      if (action.updates.id && action.updates.id !== action.id && newLayout) {
        newLayout = renameLayoutInputRef(newLayout, action.id, action.updates.id);
        newActions = newActions.map((act) => ({
          ...act,
          inputs: act.inputs?.map((iid) => iid === action.id ? action.updates.id! : iid),
        }));
      }
      return {
        ...state,
        dirty: true,
        manifest: {
          ...state.manifest,
          inputs: newInputs,
          actions: newActions,
          gui: newLayout ? { layout: newLayout } : state.manifest.gui,
        },
      };
    }

    case "UPDATE_ACTION": {
      const newActions = state.manifest.actions.map((act) =>
        act.id === action.id ? { ...act, ...action.updates } : act
      );
      let newLayout = state.manifest.gui?.layout;
      if (action.updates.id && action.updates.id !== action.id && newLayout) {
        newLayout = renameLayoutActionRef(newLayout, action.id, action.updates.id);
      }
      return {
        ...state,
        dirty: true,
        manifest: {
          ...state.manifest,
          actions: newActions,
          gui: newLayout ? { layout: newLayout } : state.manifest.gui,
        },
      };
    }

    case "UPDATE_NAMELIST": {
      const layout = state.manifest.gui?.layout;
      if (!layout) return state;
      const newLayout = cloneLayout(layout);
      const node = getNodeAtPath(newLayout, action.path);
      if (!node || node.type !== "namelist") return state;
      Object.assign(node, action.updates);
      return {
        ...state,
        dirty: true,
        manifest: { ...state.manifest, gui: { layout: newLayout } },
      };
    }

    case "MARK_CLEAN":
      return { ...state, dirty: false };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const EditorStateContext = createContext<EditorState | null>(null);
const EditorDispatchContext = createContext<Dispatch<EditorAction> | null>(null);

export function EditorStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(editorReducer, {
    manifest: { has_gui: true, inputs: [], actions: [] },
    selectedNodePath: null,
    dirty: false,
    treePath: "",
    kernelId: "",
  });

  return React.createElement(
    EditorStateContext.Provider,
    { value: state },
    React.createElement(
      EditorDispatchContext.Provider,
      { value: dispatch },
      children
    )
  );
}

export function useEditorState(): EditorState {
  const ctx = useContext(EditorStateContext);
  if (!ctx) throw new Error("useEditorState must be used within EditorStateProvider");
  return ctx;
}

export function useEditorDispatch(): Dispatch<EditorAction> {
  const ctx = useContext(EditorDispatchContext);
  if (!ctx) throw new Error("useEditorDispatch must be used within EditorStateProvider");
  return ctx;
}
