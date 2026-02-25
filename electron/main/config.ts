/**
 * config.ts — Persistent user preferences and per-workspace settings.
 *
 * Provides typed getters/setters for all PDV configuration keys and persists
 * them to `${appDataDir}/config.json`.
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

// Parse and type-check config JSON loaded from disk.
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
    if (typeof obj.pythonPath !== "string") {
      throw new Error(`Invalid config value for pythonPath in ${filePath}`);
    }
    result.pythonPath = obj.pythonPath;
  }
  if ("lastProjectDir" in obj) {
    if (typeof obj.lastProjectDir !== "string") {
      throw new Error(`Invalid config value for lastProjectDir in ${filePath}`);
    }
    result.lastProjectDir = obj.lastProjectDir;
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
  if ("theme" in obj) {
    if (obj.theme !== "light" && obj.theme !== "dark") {
      throw new Error(`Invalid config value for theme in ${filePath}`);
    }
    result.theme = obj.theme;
  }

  return result;
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

/**
 * Typed persistent configuration store for Electron main-process settings.
 *
 * Values are stored in `${appDataDir}/config.json` and loaded on startup.
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
   * @throws {Error} When the on-disk config file contains invalid JSON/shape.
   */
  constructor(private readonly appDataDir: string) {
    fs.mkdirSync(this.appDataDir, { recursive: true });
    this.configPath = path.join(this.appDataDir, "config.json");
    this.state = this.loadState();
  }

  /**
   * Read one config value by key.
   *
   * @param key - Configuration key to read.
   * @returns The stored value for `key`.
   * @throws {Error} When persisted config cannot be parsed/validated.
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
   * @throws {Error} When persisted config cannot be parsed/validated.
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

  // Read config state from disk (or default to empty state when missing).
  private loadState(): Partial<PDVConfig> {
    if (!fs.existsSync(this.configPath)) {
      return {};
    }
    const raw = fs.readFileSync(this.configPath, "utf8");
    return parseConfig(raw, this.configPath);
  }

  // Persist current in-memory state to disk.
  private persist(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
