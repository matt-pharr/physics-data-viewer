/**
 * config.ts — Persistent user preferences and per-workspace settings.
 *
 * Wraps Electron's `electron-store` (or equivalent) to provide typed
 * getters/setters for all PDV configuration keys.
 *
 * Configuration is stored in the user's app data directory and persists
 * across sessions. Workspace-specific settings (e.g. last opened project)
 * are scoped by the working directory path.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §6 (working directory lifecycle — config stores working_dir)
 * environment-detector.ts — reads pythonPath from config
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface PDVConfig {
  /** User-configured Python executable path. Undefined = auto-detect. */
  pythonPath?: string;
  /** Last project directory opened. */
  lastProjectDir?: string;
  /** Whether to show private variables in the Namespace panel. */
  showPrivateVariables: boolean;
  /** Whether to show module variables in the Namespace panel. */
  showModuleVariables: boolean;
  /** Whether to show callable variables in the Namespace panel. */
  showCallableVariables: boolean;
  /** UI theme override. Undefined = follow system. */
  theme?: "light" | "dark";
}

const CONFIG_DEFAULTS: PDVConfig = {
  showPrivateVariables: false,
  showModuleVariables: false,
  showCallableVariables: false,
};

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

export class ConfigStore {
  /**
   * Construct a ConfigStore.
   *
   * @param appDataDir - Absolute path to the Electron app data directory
   *   (``app.getPath('userData')`` in Electron main).
   */
  constructor(private readonly appDataDir: string) {
    // TODO: implement in Step 4
    throw new Error("ConfigStore constructor not yet implemented");
  }

  /** Read a config value by key. */
  get<K extends keyof PDVConfig>(key: K): PDVConfig[K] {
    // TODO: implement in Step 4
    throw new Error("ConfigStore.get not yet implemented");
  }

  /** Write a config value. */
  set<K extends keyof PDVConfig>(key: K, value: PDVConfig[K]): void {
    // TODO: implement in Step 4
    throw new Error("ConfigStore.set not yet implemented");
  }

  /** Return all config values (with defaults applied). */
  getAll(): PDVConfig {
    // TODO: implement in Step 4
    throw new Error("ConfigStore.getAll not yet implemented");
  }

  /** Reset all config values to defaults. */
  reset(): void {
    // TODO: implement in Step 4
    throw new Error("ConfigStore.reset not yet implemented");
  }
}
