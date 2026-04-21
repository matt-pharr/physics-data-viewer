/**
 * config.ts — Persistent user preferences and per-workspace settings.
 *
 * Provides typed getters/setters for all PDV configuration keys and persists
 * them to `${appDataDir}/preferences.json`.
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

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Persisted PDV user configuration values.
 *
 * Stored by the main process and exposed to the renderer through typed IPC.
 */
export interface PDVConfig {
  /** User-configured Python executable path. Undefined = auto-detect. */
  pythonPath?: string;
  /** User-configured Julia executable path. Undefined = auto-detect. */
  juliaPath?: string;
  /** Last project directory opened. */
  lastProjectDir?: string;
  /** Whether to show private variables in the Namespace panel. */
  showPrivateVariables: boolean;
  /** Whether to show module variables in the Namespace panel. */
  showModuleVariables: boolean;
  /** Whether to show callable variables in the Namespace panel. */
  showCallableVariables: boolean;
  /** Whether the Namespace panel auto-refreshes on a polling interval. */
  autoRefreshNamespace: boolean;
  /** UI theme override. Undefined = follow system. */
  theme?: "light" | "dark";
  /**
   * External editor command for Python scripts.
   * Use `{}` as the file-path placeholder, e.g. `"code {}"` or `"nvim {}"`.
   * If `{}` is absent the path is appended as the last argument.
   * Defaults to `"code {}"`.
   */
  pythonEditorCmd?: string;
  /**
   * External editor command for Julia scripts.
   * Same `{}` placeholder convention as `pythonEditorCmd`.
   */
  juliaEditorCmd?: string;
  /**
   * File-manager command used to reveal a file or folder in the OS browser.
   * Use `{}` as the placeholder, e.g. `"open {}"` (macOS) or `"xdg-open {}"` (Linux).
   */
  fileManagerCmd?: string;
  /** Recently opened project paths for menu synchronization. */
  recentProjects?: string[];
  /** Current/last active project root directory. */
  projectRoot?: string;
  /** Timestamp (ms since epoch) of last auto-update check. Internal use only. */
  lastUpdateCheck?: number;
  /** Renderer settings blob persisted by Settings dialog. */
  settings?: {
    shortcuts?: Record<string, string>;
    appearance?: {
      themeName?: string;
      colors?: Record<string, string>;
      followSystemTheme?: boolean;
      darkTheme?: string;
      lightTheme?: string;
    };
    editor?: {
      fontSize?: number;
      tabSize?: number;
      wordWrap?: boolean;
    };
    fonts?: {
      codeFont?: string;
      displayFont?: string;
    };
  };
}

const CONFIG_DEFAULTS: PDVConfig = {
  showPrivateVariables: false,
  showModuleVariables: false,
  showCallableVariables: false,
  autoRefreshNamespace: false,
  settings: {
    appearance: {
      themeName: "Dark+ (VSCode)",
      followSystemTheme: true,
      darkTheme: "Dark+ (VSCode)",
      lightTheme: "Light+ (VSCode)",
    },
  },
};

// Parse and type-check config JSON loaded from disk.
// Optional string fields may be null/undefined to explicitly clear them.
//
// Why manual validation instead of a schema library (e.g. zod)?
// 1. The config shape is flat and stable — a library adds weight for little
//    ergonomic benefit at this scale.
// 2. Field-by-field checking lets us accept partial files gracefully: a user
//    can have a config with only `pythonPath` set and everything else falls
//    back to defaults. A schema library would need explicit `.partial()` on
//    every nested level to achieve the same tolerance.
// 3. Each field's error message names the exact key and file path, which is
//    friendlier for end-user troubleshooting than generic validation errors.
function parseConfig(raw: string, filePath: string): Partial<PDVConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain an object: ${filePath}`);
  }
  const obj = parsed as Record<string, unknown>;
  const result: Partial<PDVConfig> = {};

  if ("pythonPath" in obj) {
    const pythonPath = obj.pythonPath;
    if (pythonPath !== null && pythonPath !== undefined && typeof pythonPath !== "string") {
      throw new Error(`Invalid config value for pythonPath in ${filePath}`);
    }
    if (typeof pythonPath === "string") {
      result.pythonPath = pythonPath;
    }
  }
  if ("juliaPath" in obj) {
    const juliaPath = obj.juliaPath;
    if (juliaPath !== null && juliaPath !== undefined && typeof juliaPath !== "string") {
      throw new Error(`Invalid config value for juliaPath in ${filePath}`);
    }
    if (typeof juliaPath === "string") {
      result.juliaPath = juliaPath;
    }
  }
  if ("lastProjectDir" in obj) {
    const lastProjectDir = obj.lastProjectDir;
    if (
      lastProjectDir !== null &&
      lastProjectDir !== undefined &&
      typeof lastProjectDir !== "string"
    ) {
      throw new Error(`Invalid config value for lastProjectDir in ${filePath}`);
    }
    if (typeof lastProjectDir === "string") {
      result.lastProjectDir = lastProjectDir;
    }
  }
  if ("showPrivateVariables" in obj) {
    if (typeof obj.showPrivateVariables !== "boolean") {
      throw new Error(`Invalid config value for showPrivateVariables in ${filePath}`);
    }
    result.showPrivateVariables = obj.showPrivateVariables;
  }
  if ("showModuleVariables" in obj) {
    if (typeof obj.showModuleVariables !== "boolean") {
      throw new Error(`Invalid config value for showModuleVariables in ${filePath}`);
    }
    result.showModuleVariables = obj.showModuleVariables;
  }
  if ("showCallableVariables" in obj) {
    if (typeof obj.showCallableVariables !== "boolean") {
      throw new Error(`Invalid config value for showCallableVariables in ${filePath}`);
    }
    result.showCallableVariables = obj.showCallableVariables;
  }
  if ("autoRefreshNamespace" in obj) {
    if (typeof obj.autoRefreshNamespace !== "boolean") {
      throw new Error(`Invalid config value for autoRefreshNamespace in ${filePath}`);
    }
    result.autoRefreshNamespace = obj.autoRefreshNamespace;
  }
  if ("theme" in obj) {
    const theme = obj.theme;
    if (theme !== null && theme !== undefined && theme !== "light" && theme !== "dark") {
      throw new Error(`Invalid config value for theme in ${filePath}`);
    }
    if (theme === "light" || theme === "dark") {
      result.theme = theme;
    }
  }
  for (const key of ["pythonEditorCmd", "juliaEditorCmd", "fileManagerCmd"] as const) {
    if (key in obj) {
      const val = obj[key];
      if (val !== null && val !== undefined && typeof val !== "string") {
        throw new Error(`Invalid config value for ${key} in ${filePath}`);
      }
      if (typeof val === "string") result[key] = val;
    }
  }
  if ("projectRoot" in obj) {
    const projectRoot = obj.projectRoot;
    if (projectRoot !== null && projectRoot !== undefined && typeof projectRoot !== "string") {
      throw new Error(`Invalid config value for projectRoot in ${filePath}`);
    }
    if (typeof projectRoot === "string") {
      result.projectRoot = projectRoot;
    }
  }
  if ("recentProjects" in obj) {
    const recentProjects = obj.recentProjects;
    if (recentProjects !== null && recentProjects !== undefined) {
      if (
        !Array.isArray(recentProjects) ||
        !recentProjects.every((entry) => typeof entry === "string")
      ) {
        throw new Error(`Invalid config value for recentProjects in ${filePath}`);
      }
      result.recentProjects = recentProjects;
    }
  }
  if ("settings" in obj) {
    const settings = obj.settings;
    if (
      settings !== null &&
      settings !== undefined &&
      (typeof settings !== "object" || Array.isArray(settings))
    ) {
      throw new Error(`Invalid config value for settings in ${filePath}`);
    }
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      result.settings = settings as PDVConfig["settings"];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

/**
 * Typed persistent configuration store for Electron main-process settings.
 *
 * Values are stored in `${appDataDir}/preferences.json` and loaded on startup.
 * If a legacy `config.json` is found in the same directory and `preferences.json`
 * does not yet exist, its contents are migrated automatically.
 */
export class ConfigStore {
  private readonly configPath: string;
  private state: Partial<PDVConfig>;

  /**
   * Construct a ConfigStore.
   *
   * @param appDataDir - Absolute path to the Electron app data directory
   *   (``app.getPath('userData')`` in Electron main).
   * @returns A new ConfigStore instance.
   * @throws {Error} When the app data directory cannot be created.
   */
  constructor(private readonly appDataDir: string) {
    fs.mkdirSync(this.appDataDir, { recursive: true });
    this.configPath = path.join(this.appDataDir, "preferences.json");
    this.state = this.loadState();
  }

  /**
   * Read one config value by key.
   *
   * @param key - Configuration key to read.
   * @returns The stored value for `key`.
   */
  get<K extends keyof PDVConfig>(key: K): PDVConfig[K] {
    return this.getAll()[key];
  }

  /**
   * Write one config value by key.
   *
   * @param key - Configuration key to update.
   * @param value - New value for `key`.
   * @returns Nothing.
   * @throws {Error} When the update cannot be persisted to disk.
   */
  set<K extends keyof PDVConfig>(key: K, value: PDVConfig[K]): void {
    this.state = { ...this.state, [key]: value };
    this.persist();
  }

  /**
   * Return the full configuration snapshot (defaults included).
   *
   * @returns Complete PDVConfig object.
   */
  getAll(): PDVConfig {
    return { ...CONFIG_DEFAULTS, ...this.state };
  }

  /**
   * Reset every config value back to defaults.
   *
   * @returns Nothing.
   * @throws {Error} When reset cannot be persisted to disk.
   */
  reset(): void {
    this.state = {};
    this.persist();
  }

  // Read config state from disk; on invalid/corrupt content, log and return defaults.
  private loadState(): Partial<PDVConfig> {
    if (!fs.existsSync(this.configPath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(this.configPath, "utf8");
      return parseConfig(raw, this.configPath);
    } catch (error) {
      console.error(
        `[ConfigStore] Failed to load config from ${this.configPath}; falling back to defaults.`,
        error
      );
      this.backupUnreadableConfig();
      return {};
    }
  }

  // Move unreadable config aside so future boots are clean and data is preserved for debugging.
  private backupUnreadableConfig(): void {
    if (!fs.existsSync(this.configPath)) {
      return;
    }
    const backupPath = `${this.configPath}.corrupted-${Date.now()}`;
    try {
      fs.renameSync(this.configPath, backupPath);
      console.error(`[ConfigStore] Backed up unreadable config to ${backupPath}`);
    } catch (error) {
      console.error(
        `[ConfigStore] Failed to back up unreadable config at ${this.configPath}.`,
        error
      );
    }
  }

  // Persist current in-memory state to disk.
  private persist(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
