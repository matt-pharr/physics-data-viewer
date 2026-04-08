/**
 * GuiEditorRoot.tsx — Root component for the GUI editor window.
 *
 * On mount, fetches context and manifest from the main process, then renders
 * the three-panel editor layout with a live preview.
 */

import React, { useEffect, useState, useCallback } from "react";
import type { GuiManifestV1, LayoutNode, LayoutContainer } from "../types/pdv.d";
import { EditorStateProvider, useEditorState, useEditorDispatch } from "./editor-state";
import { ElementPalette } from "./ElementPalette";
import { LayoutCanvas } from "./LayoutCanvas";
import { PropertyEditor } from "./PropertyEditor";
import { LivePreview } from "./LivePreview";

/** Collect validation warnings from the manifest. */
function validateManifest(manifest: GuiManifestV1): string[] {
  const warnings: string[] = [];
  for (const act of manifest.actions) {
    if (!act.script_path.trim()) {
      warnings.push(`Action "${act.label || act.id}" has no script path — its button won't do anything.`);
    }
  }
  // Walk layout for namelist nodes without tree_path
  function walkLayout(node: LayoutNode): void {
    if (node.type === "namelist" && !node.tree_path.trim()) {
      warnings.push("A namelist editor has no tree path — it won't display any content.");
    }
    if ("children" in node) {
      for (const child of (node as LayoutContainer).children) walkLayout(child);
    }
  }
  if (manifest.gui?.layout) walkLayout(manifest.gui.layout);
  return warnings;
}

function EditorToolbar() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    // Check for validation warnings
    const warnings = validateManifest(state.manifest);
    if (warnings.length > 0) {
      const proceed = window.confirm(
        "The following issues were found:\n\n" +
        warnings.map((w) => `• ${w}`).join("\n") +
        "\n\nSave anyway?"
      );
      if (!proceed) return;
    }

    try {
      const result = await window.pdv.guiEditor.save({
        treePath: state.treePath,
        manifest: state.manifest,
      });
      if (result.success) {
        dispatch({ type: "MARK_CLEAN" });
        setSaveStatus("Saved");
        setTimeout(() => setSaveStatus(null), 2000);
      } else {
        setSaveStatus(`Error: ${result.error}`);
      }
    } catch (err) {
      setSaveStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [state.treePath, state.manifest, dispatch]);

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // Warn on close with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (state.dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state.dirty]);

  return (
    <div className="gui-editor-toolbar">
      <div className="gui-editor-toolbar-title">
        {state.treePath}
        {state.dirty && <span className="dirty-indicator">*</span>}
      </div>
      {saveStatus && <span className="gui-editor-save-status">{saveStatus}</span>}
      <button
        className="gui-editor-save-btn"
        onClick={handleSave}
        disabled={!state.dirty}
      >
        Save
      </button>
    </div>
  );
}

/** Vertical drag handle between two side-by-side panels. */
function ColumnResizer({ onDrag }: { onDrag: (deltaX: number) => void }) {
  const onDragRef = React.useRef(onDrag);
  useEffect(() => {
    onDragRef.current = onDrag;
  });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let lastX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      onDragRef.current(dx);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return <div className="gui-editor-col-resizer" onMouseDown={handleMouseDown} />;
}

/** Horizontal drag handle between canvas and preview. */
function RowResizer({ onDrag }: { onDrag: (deltaY: number) => void }) {
  const onDragRef = React.useRef(onDrag);
  useEffect(() => {
    onDragRef.current = onDrag;
  });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let lastY = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - lastY;
      lastY = ev.clientY;
      onDragRef.current(dy);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return <div className="gui-editor-row-resizer" onMouseDown={handleMouseDown} />;
}

const MIN_COL = 140;
const MIN_ROW = 80;

function EditorContent() {
  const [paletteWidth, setPaletteWidth] = useState(220);
  const [propsWidth, setPropsWidth] = useState(280);
  const [canvasFraction, setCanvasFraction] = useState(0.5); // fraction of center height

  const centerRef = React.useRef<HTMLDivElement>(null);

  const handlePaletteResize = useCallback((delta: number) => {
    setPaletteWidth((prev) => Math.max(MIN_COL, prev + delta));
  }, []);

  const handlePropsResize = useCallback((delta: number) => {
    setPropsWidth((prev) => Math.max(MIN_COL, prev - delta));
  }, []);

  const handleRowResize = useCallback((delta: number) => {
    const el = centerRef.current;
    if (!el) return;
    const totalHeight = el.clientHeight;
    if (totalHeight <= 0) return;
    const canvasHeight = totalHeight * canvasFraction + delta;
    const clamped = Math.max(MIN_ROW, Math.min(totalHeight - MIN_ROW, canvasHeight));
    setCanvasFraction(clamped / totalHeight);
  }, [canvasFraction]);

  return (
    <div
      className="gui-editor-root"
      style={{ gridTemplateColumns: `${paletteWidth}px 4px 1fr 4px ${propsWidth}px` }}
    >
      <EditorToolbar />
      <ElementPalette />
      <ColumnResizer onDrag={handlePaletteResize} />
      <div className="gui-editor-center" ref={centerRef}>
        <div style={{ flex: canvasFraction, minHeight: MIN_ROW, overflow: "auto" }}>
          <LayoutCanvas />
        </div>
        <RowResizer onDrag={handleRowResize} />
        <div style={{ flex: 1 - canvasFraction, minHeight: MIN_ROW, overflow: "auto" }}>
          <LivePreview />
        </div>
      </div>
      <ColumnResizer onDrag={handlePropsResize} />
      <PropertyEditor />
    </div>
  );
}

export function GuiEditorRoot() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  return (
    <EditorStateProvider>
      <GuiEditorLoader
        loading={loading}
        setLoading={setLoading}
        error={error}
        setError={setError}
      />
    </EditorStateProvider>
  );
}

/**
 * Inner component that handles loading within the provider context.
 */
function GuiEditorLoader({
  loading,
  setLoading,
  error,
  setError,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  error: string | null;
  setError: (v: string | null) => void;
}) {
  const dispatch = useEditorDispatch();

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const ctx = await window.pdv.guiEditor.context();
        if (cancelled) return;
        if (!ctx) {
          setError("No editor context available");
          setLoading(false);
          return;
        }
        document.title = `GUI Editor: ${ctx.treePath}`;

        const result = await window.pdv.guiEditor.read(ctx.treePath);
        if (cancelled) return;
        if (!result.success || !result.manifest) {
          setError(result.error ?? "Failed to read GUI manifest");
          setLoading(false);
          return;
        }

        dispatch({
          type: "LOAD_MANIFEST",
          manifest: result.manifest,
          treePath: ctx.treePath,
          kernelId: ctx.kernelId,
        });
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    void init();
    return () => { cancelled = true; };
  }, [dispatch, setError, setLoading]);

  if (loading) {
    return <div className="gui-editor-loading">Loading GUI editor...</div>;
  }

  if (error) {
    return <div className="gui-editor-error">{error}</div>;
  }

  return <EditorContent />;
}
