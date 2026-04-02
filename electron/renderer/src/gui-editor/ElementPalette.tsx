/**
 * ElementPalette.tsx — Draggable catalog of GUI element types.
 *
 * Reads from ELEMENT_REGISTRY and renders grouped items that can be dragged
 * onto the LayoutCanvas.
 */

import React from "react";
import { ELEMENT_REGISTRY, type ElementTypeDefinition } from "./element-registry";

const DRAG_MIME = "application/pdv-element";

function PaletteItem({ def }: { def: ElementTypeDefinition }) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, def.type);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      className="gui-editor-palette-item"
      draggable
      onDragStart={handleDragStart}
    >
      <div className="gui-editor-palette-icon">{def.icon}</div>
      <div className="gui-editor-palette-info">
        <div className="gui-editor-palette-label">{def.label}</div>
        <div className="gui-editor-palette-desc">{def.description}</div>
      </div>
    </div>
  );
}

export function ElementPalette() {
  const containers = ELEMENT_REGISTRY.filter((d) => d.category === "container");
  const leaves = ELEMENT_REGISTRY.filter((d) => d.category === "leaf");

  return (
    <div className="gui-editor-palette">
      <div className="gui-editor-palette-section">
        <div className="gui-editor-palette-section-title">Containers</div>
        {containers.map((def) => (
          <PaletteItem key={def.type} def={def} />
        ))}
      </div>
      <div className="gui-editor-palette-section">
        <div className="gui-editor-palette-section-title">Controls</div>
        {leaves.map((def) => (
          <PaletteItem key={def.type} def={def} />
        ))}
      </div>
    </div>
  );
}
