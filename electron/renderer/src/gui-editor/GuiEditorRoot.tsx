/**
 * GuiEditorRoot.tsx — Root component for the GUI editor window.
 *
 * On mount, fetches context and manifest from the main process, then renders
 * the three-panel editor layout with a live preview.
 */

import React, { useEffect, useState, useCallback } from "react";
import type { GuiEditorContext } from "../types/pdv.d";
import { EditorStateProvider, useEditorState, useEditorDispatch } from "./editor-state";
import { ElementPalette } from "./ElementPalette";
import { LayoutCanvas } from "./LayoutCanvas";
import { PropertyEditor } from "./PropertyEditor";
import { LivePreview } from "./LivePreview";

function EditorToolbar() {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
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

function EditorContent() {
  return (
    <div className="gui-editor-root">
      <EditorToolbar />
      <ElementPalette />
      <div className="gui-editor-center">
        <LayoutCanvas />
        <LivePreview />
      </div>
      <PropertyEditor />
    </div>
  );
}

export function GuiEditorRoot() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<GuiEditorContext | null>(null);

  return (
    <EditorStateProvider>
      <GuiEditorLoader
        loading={loading}
        setLoading={setLoading}
        error={error}
        setError={setError}
        context={context}
        setContext={setContext}
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
  context,
  setContext,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  error: string | null;
  setError: (v: string | null) => void;
  context: GuiEditorContext | null;
  setContext: (v: GuiEditorContext | null) => void;
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
        setContext(ctx);
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
  }, [dispatch, setContext, setError, setLoading]);

  if (loading) {
    return <div className="gui-editor-loading">Loading GUI editor...</div>;
  }

  if (error) {
    return <div className="gui-editor-error">{error}</div>;
  }

  return <EditorContent />;
}
