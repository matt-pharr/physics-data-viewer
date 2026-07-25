/**
 * ipc-register-config.ts — Server-side `config.*` invoke handlers.
 *
 * The ConfigStore caches state at construction, so exactly one process may
 * own it: the pdv-server core. `config:get` / `config:set` are therefore
 * server channels; shell-side consumers (auto-updater timestamps, launcher
 * command lookups) read and write asynchronously through the invoke path
 * instead of holding their own store.
 *
 * Non-responsibilities:
 * - Config persistence mechanics (see `config.ts`).
 * - Side effects of config changes (autosave-timer restart lives with the
 *   session wiring, injected via `onConfigChanged`).
 */

import type { ConfigStore } from "./config";
import { IPC, type PDVConfig } from "./ipc";
import { handleInvoke } from "./server/invoke-registry";

/** Renderer-facing defaults merged under the persisted config. */
export const DEFAULT_CONFIG: PDVConfig = {
  showPrivateVariables: false,
  showModuleVariables: false,
  showCallableVariables: false,
  autoRefreshNamespace: false,
};

/**
 * Read the current app configuration.
 *
 * @param configStore - Config store dependency.
 * @returns Current config snapshot (defaults merged under persisted values).
 */
export function readConfig(configStore: ConfigStore): PDVConfig {
  const raw = configStore.getAll();
  return { ...DEFAULT_CONFIG, ...raw };
}

/** Dependency bag for {@link registerConfigIpcHandlers}. */
export interface RegisterConfigIpcHandlersOptions {
  /** Config persistence dependency. */
  configStore: ConfigStore;
  /** Called after `config:set` with the old and new config values. */
  onConfigChanged?: (prev: PDVConfig, next: PDVConfig) => void;
}

/**
 * Register the `config.*` invoke handlers.
 *
 * @param options - Dependency bag; see {@link RegisterConfigIpcHandlersOptions}.
 * @returns Nothing.
 */
export function registerConfigIpcHandlers(
  options: RegisterConfigIpcHandlersOptions
): void {
  const { configStore, onConfigChanged } = options;

  handleInvoke(IPC.config.get, async () => readConfig(configStore));

  handleInvoke(IPC.config.set, async (_ctx, updates: Partial<PDVConfig>) => {
    const prev = readConfig(configStore);
    const merged: PDVConfig = { ...prev, ...updates };
    for (const key of Object.keys(updates) as Array<keyof PDVConfig>) {
      const value = updates[key];
      if (value === undefined) continue;
      if ((key === "mcp" || key === "launchers") && value !== null && typeof value === "object") {
        // Shallow-merge these nested subtrees rather than full-replacing them:
        // - `mcp`: the renderer's `Config['mcp']` type omits main-only fields
        //   (e.g. `authToken`); a full replace would drop the persisted bearer
        //   token and break every connected agent on the next toggle.
        // - `launchers`: a caller may send a partial update (just `terminal`,
        //   say); a full replace would silently drop the sibling `editor` /
        //   `agent` slots.
        const existing = (configStore.get(key) ?? {}) as Record<string, unknown>;
        configStore.set(key, {
          ...existing,
          ...(value as Record<string, unknown>),
        } as PDVConfig[typeof key]);
      } else {
        configStore.set(key, value);
      }
    }
    const next = { ...merged, ...configStore.getAll() };
    onConfigChanged?.(prev, next);
    return next;
  });
}
