/**
 * LayoutCanvas.tsx — Structural tree editor for the GUI layout.
 *
 * Renders the layout hierarchy as an indented tree, supports drag-and-drop
 * from the palette and within the tree for reordering/nesting.
 */

import React, { useState, useCallback } from "react";
import type { LayoutNode, LayoutContainer, GuiManifestV1 } from "../types/pdv.d";
import { useEditorState, useEditorDispatch } from "./editor-state";
import { ELEMENT_REGISTRY, getElementDef } from "./element-registry";

const DRAG_MIME = "application/pdv-element";
const CANVAS_DRAG_MIME = "application/pdv-canvas-path";

/** Get a display label for a layout node. */
function nodeDisplayLabel(node: LayoutNode, manifest: GuiManifestV1): string {
  if ("children" in node) {
    const c = node as LayoutContainer;
    if (c.label) return `${c.type}: "${c.label}"`;
    return c.type;
  }
  if (node.type === "input" && "id" in node) {
    const inp = manifest.inputs.find((i) => i.id === node.id);
    return inp ? `${inp.label} (${node.id})` : `input: ${node.id}`;
  }
  if (node.type === "action" && "id" in node) {
    const act = manifest.actions.find((a) => a.id === node.id);
    return act ? `${act.label} (${node.id})` : `action: ${node.id}`;
  }
  if (node.type === "namelist") {
    return `namelist: ${node.tree_path || "(no path)"}`;
  }
  return node.type;
}

/** Get a validation warning for a node, if any. */
function nodeWarning(node: LayoutNode, manifest: GuiManifestV1): string | null {
  if (node.type === "action" && "id" in node) {
    const act = manifest.actions.find((a) => a.id === node.id);
    if (act && !act.script_path.trim()) return "No script path set";
  }
  if (node.type === "namelist" && !node.tree_path.trim()) {
    return "No tree path set";
  }
  return null;
}

/** Get icon for a node from registry. */
function nodeIcon(node: LayoutNode): string {
  const def = getElementDef(node.type);
  return def?.icon ?? "?";
}

interface DropZoneProps {
  parentPath: string;
  index: number;
  onDrop: (parentPath: string, index: number, elementType: string | null, fromPath: string | null) => void;
}

function DropZone({ parentPath, index, onDrop }: DropZoneProps) {
  const [active, setActive] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_MIME) ? "copy" : "move";
    setActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    setActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(false);
    const elementType = e.dataTransfer.getData(DRAG_MIME);
    const fromPath = e.dataTransfer.getData(CANVAS_DRAG_MIME);
    onDrop(parentPath, index, elementType || null, fromPath || null);
  };

  return (
    <div
      className={`canvas-drop-zone${active ? " active" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    />
  );
}

interface CanvasNodeProps {
  node: LayoutNode;
  path: string;
  onDrop: (parentPath: string, index: number, elementType: string | null, fromPath: string | null) => void;
}

function CanvasNode({ node, path, onDrop }: CanvasNodeProps) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [collapsed, setCollapsed] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);

  const isContainer = "children" in node;
  const isRoot = path === "";
  const isSelected = state.selectedNodePath === path;
  const children = isContainer ? (node as LayoutContainer).children : [];
  const warning = nodeWarning(node, state.manifest);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: "SELECT_NODE", path });
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: "DELETE_NODE", path });
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(CANVAS_DRAG_MIME, path);
    e.dataTransfer.effectAllowed = "move";
  };

  // Container drop target (drop INTO the container)
  const handleContainerDragOver = (e: React.DragEvent) => {
    if (!isContainer) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(true);
  };

  const handleContainerDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    setDropTarget(false);
  };

  const handleContainerDrop = (e: React.DragEvent) => {
    if (!isContainer) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);
    const elementType = e.dataTransfer.getData(DRAG_MIME);
    const fromPath = e.dataTransfer.getData(CANVAS_DRAG_MIME);
    // Drop at end of container's children
    onDrop(path, children.length, elementType || null, fromPath || null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      dispatch({ type: "DELETE_NODE", path });
    }
  };

  return (
    <div className="canvas-node">
      <div
        className={`canvas-node-row${isSelected ? " selected" : ""}${dropTarget ? " drop-target" : ""}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        draggable={!isRoot}
        onDragStart={isRoot ? undefined : handleDragStart}
        onDragOver={isContainer ? handleContainerDragOver : undefined}
        onDragLeave={isContainer ? handleContainerDragLeave : undefined}
        onDrop={isContainer ? handleContainerDrop : undefined}
        tabIndex={0}
      >
        {isContainer && (
          <button
            className="canvas-node-toggle"
            onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
          >
            {collapsed ? "\u25B6" : "\u25BC"}
          </button>
        )}
        <div className="canvas-node-icon">{nodeIcon(node)}</div>
        <div className="canvas-node-label">
          {nodeDisplayLabel(node, state.manifest)}
          {warning && <span className="canvas-node-warning" title={warning}> &#x26A0;</span>}
        </div>
        {!isRoot && <button className="canvas-node-delete" onClick={handleDelete} title="Delete">&times;</button>}
      </div>
      {isContainer && !collapsed && (
        <div className="canvas-node-children">
          <DropZone parentPath={path} index={0} onDrop={onDrop} />
          {children.map((child, i) => {
            const childPath = path ? `${path}.${i}` : String(i);
            return (
              <React.Fragment key={childPath}>
                <CanvasNode node={child} path={childPath} onDrop={onDrop} />
                <DropZone parentPath={path} index={i + 1} onDrop={onDrop} />
              </React.Fragment>
            );
          })}
          {children.length === 0 && (
            <div className="gui-editor-canvas-empty" style={{ height: 32, fontSize: 11 }}>
              Drop elements here
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LayoutCanvas() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const layout = state.manifest.gui?.layout;

  const handleDrop = useCallback(
    (parentPath: string, index: number, elementType: string | null, fromPath: string | null) => {
      if (fromPath) {
        // Move within canvas
        dispatch({ type: "MOVE_NODE", fromPath, toParentPath: parentPath, toIndex: index });
      } else if (elementType) {
        // Drop from palette
        const def = ELEMENT_REGISTRY.find((e) => e.type === elementType);
        if (!def) return;
        const { node, input, action } = def.factory(state.manifest);
        dispatch({ type: "ADD_NODE", parentPath, index, node, input, action });
      }
    },
    [dispatch, state.manifest]
  );

  if (!layout) {
    return (
      <div className="gui-editor-canvas">
        <div className="gui-editor-canvas-empty">No layout defined</div>
      </div>
    );
  }

  return (
    <div className="gui-editor-canvas">
      <CanvasNode node={layout} path="" onDrop={handleDrop} />
    </div>
  );
}
