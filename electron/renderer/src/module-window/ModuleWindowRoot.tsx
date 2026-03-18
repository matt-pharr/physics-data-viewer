/**
 * ModuleWindowRoot.tsx — Root component for module GUI popup windows.
 *
 * On mount, retrieves the module context (alias + kernelId) from the main
 * process, loads the module descriptor, and renders the module GUI.
 *
 * Actions are routed back to the main window for console execution via
 * `window.pdv.moduleWindows.executeInMain()`.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportedModuleDescriptor,
  ModuleWindowContext,
} from "../types/pdv";
import { ModuleInputsPanel } from "../components/ModulesPanel/ModuleInputsPanel";
import { ModuleActionsPanel } from "../components/ModulesPanel/ModuleActionsPanel";
import { ContainerRenderer } from "../components/ModuleGui/ContainerRenderer";
import {
  ACTIVE_TAB_SETTING_KEY,
  DEFAULT_MODULE_TAB,
  getActionTabName,
  getInputSectionName,
  getInputTabName,
  isModuleInputValue,
  sectionSettingKey,
  type ModuleInputDescriptor,
  type ModuleInputValue,
} from "../components/ModulesPanel/moduleUiHelpers";

export const ModuleWindowRoot: React.FC = () => {
  const [context, setContext] = useState<ModuleWindowContext | null>(null);
  const [descriptor, setDescriptor] = useState<ImportedModuleDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Input/UI state
  const [inputValues, setInputValues] = useState<Record<string, ModuleInputValue>>({});
  const [persistedSettings, setPersistedSettings] = useState<Record<string, unknown>>({});
  const [activeTab, setActiveTab] = useState<string>(DEFAULT_MODULE_TAB);
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({});
  const [runningActionKey, setRunningActionKey] = useState<string | null>(null);

  // Initialize: get context and load module descriptor
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctx = await window.pdv.moduleWindows.context();
        if (cancelled || !ctx) {
          if (!cancelled) setError("No module context available.");
          return;
        }
        setContext(ctx);

        const importedModules = await window.pdv.modules.listImported();
        const mod = importedModules.find((m) => m.alias === ctx.alias);
        if (!mod) {
          setError(`Module not found: ${ctx.alias}`);
          return;
        }

        // Resolve tree-backed dropdown options
        const resolvedInputs = await Promise.all(
          mod.inputs.map(async (input) => {
            if (input.control !== "dropdown" || !input.optionsTreePath) {
              return input;
            }
            const treePath = input.optionsTreePath.trim();
            if (!treePath) return { ...input, options: [] };
            const nodes = await window.pdv.tree.list(ctx.kernelId, treePath);
            return {
              ...input,
              options: nodes.map((node) => ({ label: node.key, value: node.key })),
            };
          })
        );

        const resolvedMod = { ...mod, inputs: resolvedInputs };

        // Initialize input values from settings
        const settings =
          mod.settings && typeof mod.settings === "object" && !Array.isArray(mod.settings)
            ? mod.settings
            : {};
        const values: Record<string, ModuleInputValue> = {};
        const sectionState: Record<string, boolean> = {};

        const tabNames = Array.from(
          new Set([
            ...resolvedInputs.map((input) => getInputTabName(input)),
            ...mod.actions.map((action) => getActionTabName(action)),
          ])
        );
        const savedTab = settings[ACTIVE_TAB_SETTING_KEY];
        const initialTab =
          typeof savedTab === "string" && tabNames.includes(savedTab)
            ? savedTab
            : (tabNames[0] ?? DEFAULT_MODULE_TAB);

        for (const input of resolvedInputs) {
          const key = `${ctx.alias}:${input.id}`;
          const persisted = settings[input.id];
          if (isModuleInputValue(persisted)) {
            values[key] = persisted;
          } else if (input.default !== undefined) {
            values[key] = input.default;
          }
          const tabName = getInputTabName(input);
          const sectionName = getInputSectionName(input);
          if (!sectionName) continue;
          const stateKey = `${tabName}::${sectionName}`;
          if (sectionState[stateKey] !== undefined) continue;
          const savedOpen = settings[sectionSettingKey(tabName, sectionName)];
          if (typeof savedOpen === "boolean") {
            sectionState[stateKey] = savedOpen;
          } else {
            sectionState[stateKey] = !(input.sectionCollapsed ?? false);
          }
        }

        if (!cancelled) {
          setDescriptor(resolvedMod);
          setPersistedSettings(settings);
          setInputValues(values);
          setActiveTab(initialTab);
          setSectionOpen(sectionState);
          setLoading(false);
          document.title = `Module: ${mod.name}`;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Subscribe to tree changes for dropdown refresh
  useEffect(() => {
    if (!context || !descriptor) return;
    const unsub = window.pdv.tree.onChanged(() => {
      // Re-resolve tree-backed dropdowns
      (async () => {
        try {
          const resolvedInputs = await Promise.all(
            descriptor.inputs.map(async (input) => {
              if (input.control !== "dropdown" || !input.optionsTreePath) {
                return input;
              }
              const treePath = input.optionsTreePath.trim();
              if (!treePath) return { ...input, options: [] };
              const nodes = await window.pdv.tree.list(context.kernelId, treePath);
              return {
                ...input,
                options: nodes.map((node) => ({ label: node.key, value: node.key })),
              };
            })
          );
          setDescriptor((prev) => (prev ? { ...prev, inputs: resolvedInputs } : prev));
        } catch {
          // Silently ignore refresh errors
        }
      })();
    });
    return unsub;
  }, [context, descriptor]);

  const moduleTabs = useMemo(() => {
    if (!descriptor) return [];
    return Array.from(
      new Set([
        ...descriptor.inputs.map((input) => getInputTabName(input)),
        ...descriptor.actions.map((action) => getActionTabName(action)),
      ])
    );
  }, [descriptor]);

  const persistModuleSettings = useCallback(
    async (nextSettings: Record<string, unknown>): Promise<void> => {
      if (!context) return;
      const result = await window.pdv.modules.saveSettings({
        moduleAlias: context.alias,
        values: nextSettings,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Failed to save settings");
      }
      setPersistedSettings(nextSettings);
    },
    [context]
  );

  const persistInputValues = useCallback(
    async (moduleAlias: string): Promise<void> => {
      if (!descriptor) return;
      const nextSettings = { ...persistedSettings };
      for (const input of descriptor.inputs) {
        const key = `${moduleAlias}:${input.id}`;
        const val = inputValues[key];
        if (typeof val === "string") {
          const trimmed = val.trim();
          if (trimmed.length > 0) {
            nextSettings[input.id] = trimmed;
          } else {
            delete nextSettings[input.id];
          }
          continue;
        }
        if (typeof val === "number" || typeof val === "boolean") {
          nextSettings[input.id] = val;
          continue;
        }
        delete nextSettings[input.id];
      }
      await persistModuleSettings(nextSettings);
    },
    [descriptor, inputValues, persistedSettings, persistModuleSettings]
  );

  const setModuleInputValue = useCallback(
    (_moduleAlias: string, inputId: string, value: ModuleInputValue): void => {
      if (!context) return;
      const key = `${context.alias}:${inputId}`;
      setInputValues((prev) => ({ ...prev, [key]: value }));
    },
    [context]
  );

  const isInputVisible = useCallback(
    (moduleAlias: string, input: ModuleInputDescriptor): boolean => {
      if (!input.visibleIf) return true;
      const depKey = `${moduleAlias}:${input.visibleIf.inputId}`;
      return inputValues[depKey] === input.visibleIf.equals;
    },
    [inputValues]
  );

  const handleSetModuleTab = useCallback(
    async (_moduleAlias: string, tabName: string): Promise<void> => {
      setActiveTab(tabName);
      const nextSettings = {
        ...persistedSettings,
        [ACTIVE_TAB_SETTING_KEY]: tabName,
      };
      await persistModuleSettings(nextSettings);
    },
    [persistedSettings, persistModuleSettings]
  );

  const handleSetSectionOpen = useCallback(
    async (
      _moduleAlias: string,
      tabName: string,
      sectionName: string,
      isOpen: boolean
    ): Promise<void> => {
      const stateKey = `${tabName}::${sectionName}`;
      setSectionOpen((prev) => ({ ...prev, [stateKey]: isOpen }));
      const nextSettings = {
        ...persistedSettings,
        [sectionSettingKey(tabName, sectionName)]: isOpen,
      };
      await persistModuleSettings(nextSettings);
    },
    [persistedSettings, persistModuleSettings]
  );

  const toActionInputValue = useCallback(
    (value: ModuleInputValue | undefined, input: ModuleInputDescriptor): ModuleInputValue | null => {
      if (value === undefined) return null;
      if (input.control === "checkbox") return Boolean(value);
      if (input.control === "slider") {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      return value;
    },
    []
  );

  const handleRunAction = useCallback(
    async (actionId: string): Promise<void> => {
      if (!descriptor || !context) return;
      const action = descriptor.actions.find((a) => a.id === actionId);
      if (!action) return;

      const actionKey = `${context.alias}:${actionId}`;
      setRunningActionKey(actionKey);
      setError(null);

      try {
        await persistInputValues(context.alias);

        const actionInputValues: Record<string, ModuleInputValue> = {};
        const referencedIds = action.inputIds ?? [];
        const inputById = new Map(
          descriptor.inputs.map((input) => [input.id, input] as const)
        );
        for (const inputId of referencedIds) {
          const key = `${context.alias}:${inputId}`;
          const input = inputById.get(inputId);
          if (!input) continue;
          const value = toActionInputValue(inputValues[key], input);
          if (value !== null) {
            actionInputValues[inputId] = value;
          }
        }

        const result = await window.pdv.modules.runAction({
          kernelId: context.kernelId,
          moduleAlias: context.alias,
          actionId,
          inputValues:
            Object.keys(actionInputValues).length > 0
              ? actionInputValues
              : undefined,
        });

        if (!result.success || !result.executionCode) {
          throw new Error(result.error ?? `Failed to run action ${actionId}`);
        }

        await window.pdv.moduleWindows.executeInMain(result.executionCode);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunningActionKey(null);
      }
    },
    [descriptor, context, inputValues, persistInputValues, toActionInputValue]
  );

  const handleSetError = useCallback((msg: string) => setError(msg), []);

  if (loading) {
    return (
      <div className="module-window-root" style={{ padding: 16 }}>
        <div style={{ color: "var(--text-secondary)" }}>Loading module...</div>
      </div>
    );
  }

  if (error && !descriptor) {
    return (
      <div className="module-window-root" style={{ padding: 16 }}>
        <div style={{ color: "var(--error)" }}>{error}</div>
      </div>
    );
  }

  if (!descriptor || !context) {
    return (
      <div className="module-window-root" style={{ padding: 16 }}>
        <div style={{ color: "var(--text-secondary)" }}>No module loaded.</div>
      </div>
    );
  }

  const hasGuiLayout = !!descriptor.gui?.layout;

  return (
    <div className="module-window-root" style={{ padding: 12, overflow: "auto", height: "100vh", boxSizing: "border-box" }}>
      <div className="modules-name" style={{ marginBottom: 4 }}>{descriptor.name}</div>
      <div className="modules-meta" style={{ marginBottom: 8 }}>
        v{descriptor.version} &middot; {descriptor.alias}
      </div>

      {descriptor.warnings.length > 0 && (
        <div className="modules-warning-block" style={{ marginBottom: 8 }}>
          {descriptor.warnings.map((w, i) => (
            <div key={`${w.code}-${i}`} className="modules-warning-item">
              {w.message}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ color: "var(--error)", marginBottom: 8, fontSize: 12 }}>{error}</div>
      )}

      {hasGuiLayout ? (
        <ContainerRenderer
          node={descriptor.gui!.layout}
          moduleAlias={context.alias}
          inputs={descriptor.inputs}
          actions={descriptor.actions}
          inputValues={inputValues}
          sectionOpen={sectionOpen}
          runningActionKey={runningActionKey}
          kernelReady={true}
          kernelId={context.kernelId}
          isInputVisible={isInputVisible}
          setModuleInputValue={setModuleInputValue}
          persistInputValues={persistInputValues}
          setSectionOpenState={handleSetSectionOpen}
          onRunAction={handleRunAction}
          onError={handleSetError}
        />
      ) : (
        <>
          {moduleTabs.length > 1 && (
            <div className="modules-input-tabs" style={{ marginBottom: 8 }}>
              {moduleTabs.map((tabName) => (
                <button
                  key={tabName}
                  className={`modules-tab ${tabName === activeTab ? "active" : ""}`}
                  onClick={() =>
                    void handleSetModuleTab(context.alias, tabName).catch((err) =>
                      setError(err instanceof Error ? err.message : String(err))
                    )
                  }
                >
                  {tabName}
                </button>
              ))}
            </div>
          )}

          <ModuleInputsPanel
            moduleAlias={context.alias}
            inputs={descriptor.inputs}
            activeTab={activeTab}
            inputValues={inputValues}
            sectionOpenState={sectionOpen}
            isInputVisible={isInputVisible}
            setModuleInputValue={setModuleInputValue}
            persistInputValues={persistInputValues}
            setSectionOpenState={handleSetSectionOpen}
            onError={handleSetError}
          />

          <ModuleActionsPanel
            moduleAlias={context.alias}
            actions={descriptor.actions}
            activeTab={activeTab}
            runningActionKey={runningActionKey}
            kernelReady={true}
            kernelId={context.kernelId}
            onRunAction={handleRunAction}
          />
        </>
      )}
    </div>
  );
};
