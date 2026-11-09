/**
 * ipc-register-config.ts — Invoke handlers for the *server-owned half* of
 * the config.
 *
 * The ConfigStore caches state at construction, so exactly one process may
 * own it: the pdv-server core. These handlers are registered on the
 * internal `pdv.internal.serverConfig*` channels rather than the
 * renderer-facing `config:*` ones, because the config is split in two: keys
 * the server reads for itself (`pythonPath`, `workingDirBase`,
 * `defaultPackages`, `uv`, `mcp`) belong to whichever host runs the
 * session and live here, while the ones only the renderer and shell read
 * (theme, shortcuts, launchers) follow the user and live in
 * `shell/local-config-store.ts`. `shell/config-bridge.ts` merges both
 * halves behind the unchanged `config:*` API.
 *
 * Non-responsibilities:
 * - Config persistence mechanics (see `config.ts`).
 * - Deciding ownership (see `shell/local-config-store.ts`).
 * - Side effects of config changes (autosave-timer restart lives with the
 *   session wiring, injected via `onConfigChanged`).
 */

import type { ConfigStore } from "./config";
import { INTERNAL_CHANNELS, type PDVConfig } from "./ipc";
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

  handleInvoke(INTERNAL_CHANNELS.serverConfigGet, async () =>
    readConfig(configStore)
  );

  handleInvoke(
    INTERNAL_CHANNELS.serverConfigSet,
    async (_ctx, updates: Partial<PDVConfig>) => {
      const prev = readConfig(configStore);
      const merged: PDVConfig = { ...prev, ...updates };
      for (const key of Object.keys(updates) as Array<keyof PDVConfig>) {
        const value = updates[key];
        if (value === undefined) continue;
        if (key === "mcp" && value !== null && typeof value === "object") {
          // Shallow-merge rather than full-replacing: the renderer's
          // `Config['mcp']` type omits main-only fields (e.g. `authToken`),
          // so a full replace would drop the persisted bearer token and
          // break every connected agent on the next toggle.
          //
          // `launchers` used to need the same treatment; it is now
          // shell-owned and never reaches this handler, so its merge lives
          // in `LocalConfigStore.apply` instead.
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
    }
  );
}
