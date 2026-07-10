/**
 * GuiViewerRoot.tsx — Root component for standalone GUI viewer windows.
 *
 * Loads a gui.json manifest from a PDVGui tree node and renders it using
 * the existing ContainerRenderer. Provides local input state and routes
 * action execution through the main window.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type {
  GuiEditorContext,
  GuiManifestV1,
  ModuleInputDescriptor,
} from "../types/pdv.d";
import { ContainerRenderer } from "../components/ModuleGui/ContainerRenderer";
import {
  adaptGuiActions,
  resolveTreeDropdownOptions,
} from "../components/ModuleGui/gui-host-utils";
import "../styles/module-gui.css";

type ModuleInputValue = string | number | boolean;

export function GuiViewerRoot() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<GuiEditorContext | null>(null);
  const [manifest, setManifest] = useState<GuiManifestV1 | null>(null);
  const manifestRef = useRef(manifest);
  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

  const [inputValues, setInputValues] = useState<Record<string, ModuleInputValue>>({});
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({});
  const [runningActionKey, setRunningActionKey] = useState<string | null>(null);

  const viewerAlias = context?.treePath ?? "__gui_viewer__";

  // ── Initialization ──
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Reuse guiEditor context/read channels — the viewer window is opened
        // by the same GuiViewerWindowManager which stores GuiEditorContext.
        const ctx = await window.pdv.guiEditor.context();
        if (cancelled) return;
        if (!ctx) {
          setError("No viewer context available");
          setLoading(false);
          return;
        }
        setContext(ctx);

        const result = await window.pdv.guiEditor.read(ctx.treePath);
        if (cancelled) return;
        if (!result.success || !result.manifest) {
          setError(result.error ?? "Failed to read GUI manifest");
          setLoading(false);
          return;
        }

        // Resolve tree-backed dropdown options (dropdowns bound to an
        // `optionsTreePath` were previously left empty in the viewer).
        const resolvedInputs = await resolveTreeDropdownOptions(
          result.manifest.inputs,
          ctx.kernelId
        );
        if (cancelled) return;
        setManifest({ ...result.manifest, inputs: resolvedInputs });

        // Initialize input defaults
        const defaults: Record<string, ModuleInputValue> = {};
        for (const input of resolvedInputs) {
          if (input.default != null) {
            defaults[`${ctx.treePath}:${input.id}`] = input.default;
          }
        }
        setInputValues(defaults);

        document.title = ctx.treePath.split(".").pop() ?? "GUI";
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    void init();
    return () => { cancelled = true; };
  }, []);

  // Refresh tree-backed dropdowns when the tree changes (same behavior as
  // module windows).
  useEffect(() => {
    if (!context) return;
    const unsub = window.pdv.tree.onChanged(() => {
      const current = manifestRef.current;
      if (!current) return;
      void (async () => {
        try {
          const resolvedInputs = await resolveTreeDropdownOptions(
            current.inputs,
            context.kernelId
          );
          setManifest((prev) => (prev ? { ...prev, inputs: resolvedInputs } : prev));
        } catch {
          // Silently ignore refresh errors
        }
      })();
    });
    return unsub;
  }, [context]);

  // ── Callbacks ──
  const setModuleInputValue = useCallback(
    (_alias: string, inputId: string, value: ModuleInputValue) => {
      setInputValues((prev) => ({ ...prev, [`${viewerAlias}:${inputId}`]: value }));
    },
    [viewerAlias]
  );

  const persistInputValues = useCallback(async (_alias: string) => {
    // Standalone GUIs don't persist settings to modules
  }, []);

  const isInputVisible = useCallback(
    (_alias: string, input: ModuleInputDescriptor) => {
      if (!input.visibleIf) return true;
      const key = `${viewerAlias}:${input.visibleIf.inputId}`;
      return inputValues[key] === input.visibleIf.equals;
    },
    [inputValues, viewerAlias]
  );

  const handleSetSectionOpen = useCallback(
    async (_alias: string, tabName: string, sectionName: string, isOpen: boolean) => {
      const key = `${tabName}::${sectionName}`;
      setSectionOpen((prev) => ({ ...prev, [key]: isOpen }));
    },
    []
  );

  const handleRunAction = useCallback(
    async (actionId: string) => {
      if (!context || !manifest) return;
      const action = manifest.actions.find((a) => a.id === actionId);
      if (!action) return;

      const actionKey = `${viewerAlias}:${actionId}`;
      setRunningActionKey(actionKey);

      try {
        // Resolve script path relative to GUI parent. Strip the script file
        // extension language-agnostically (.py or .jl — not just Python).
        const guiParent = context.treePath.includes(".")
          ? context.treePath.substring(0, context.treePath.lastIndexOf("."))
          : "";
        const scriptSegment = action.script_path
          .replace(/\.(py|jl)$/i, "")
          .replace(/\//g, ".");
        const scriptTreePath = guiParent
          ? `${guiParent}.${scriptSegment}`
          : scriptSegment;

        // Collect input values for the action
        const params: Record<string, string | number | boolean> = {};
        for (const inputId of action.inputs ?? []) {
          const key = `${viewerAlias}:${inputId}`;
          if (key in inputValues) {
            params[inputId] = inputValues[key];
          }
        }

        const executionId = `gui-action-${Date.now()}`;
        const result = await window.pdv.script.run(context.kernelId, {
          treePath: scriptTreePath,
          params,
          executionId,
          origin: { kind: "unknown", label: `GUI: ${action.label}` },
        });

        if (result.result?.error) {
          setError(result.result.error as string);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunningActionKey(null);
      }
    },
    [context, manifest, inputValues, viewerAlias]
  );

  const handleError = useCallback((msg: string) => {
    setError(msg);
  }, []);

  // ── Render ──
  if (loading) {
    return <div style={{ padding: 16, color: "var(--text-primary)" }}>Loading GUI...</div>;
  }

  if (error && !manifest) {
    return <div style={{ padding: 16, color: "var(--error)" }}>{error}</div>;
  }

  if (!manifest?.gui?.layout) {
    return <div style={{ padding: 16, color: "var(--text-secondary)" }}>This GUI has no layout defined.</div>;
  }

  return (
    <div style={{ padding: 12 }}>
      {error && (
        <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--bg-tertiary)", color: "var(--error)", borderRadius: 4 }}>
          {error}
          <button
            onClick={() => setError(null)}
            style={{ marginLeft: 12, background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
          >
            Dismiss
          </button>
        </div>
      )}
      <ContainerRenderer
        node={manifest.gui.layout}
        moduleAlias={viewerAlias}
        inputs={manifest.inputs}
        actions={adaptGuiActions(manifest.actions)}
        inputValues={inputValues}
        sectionOpen={sectionOpen}
        runningActionKey={runningActionKey}
        kernelReady={!!context?.kernelId}
        kernelId={context?.kernelId ?? null}
        isInputVisible={isInputVisible}
        setModuleInputValue={setModuleInputValue}
        persistInputValues={persistInputValues}
        setSectionOpenState={handleSetSectionOpen}
        onRunAction={handleRunAction}
        onError={handleError}
      />
    </div>
  );
}
