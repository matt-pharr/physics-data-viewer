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

import { atomicWriteFileSync } from "./atomic-write";

import {
  TERMINAL_PRESET_LIST,
  type AgentLauncherConfig,
  type EditorLauncherConfig,
  type TerminalLauncherConfig,
  type TerminalPreset,
} from "./editor-spawn";

const TERMINAL_PRESET_SET: ReadonlySet<TerminalPreset> = new Set(TERMINAL_PRESET_LIST);

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
   * @deprecated Superseded by `launchers.editor.fileCommand`. Retained so the
   * one-shot migration in {@link ConfigStore} can pick up pre-existing values;
   * no longer written once a user has the `launchers.editor` block.
   */
  pythonEditorCmd?: string;
  /**
   * @deprecated Superseded by `launchers.editor.fileCommand`. See
   * {@link PDVConfig.pythonEditorCmd}.
   */
  juliaEditorCmd?: string;
  /** Recently opened project paths for menu synchronization. */
  recentProjects?: string[];
  /** Current/last active project root directory. */
  projectRoot?: string;
  /** Timestamp (ms since epoch) of last auto-update check. Internal use only. */
  lastUpdateCheck?: number;
  /** Default parent directory for new project saves (pre-fills Save As dialog). */
  defaultSaveLocation?: string;
  /** Base directory for session working directories. Defaults to `~/.PDV/working/`. */
  workingDirBase?: string;
  /** Autosave interval in seconds. Default 300 (5 minutes). Minimum 30. */
  autoSaveIntervalSeconds?: number;
  /**
   * Packages (PEP 508 specs) seeded into a new uv project's pyproject.toml
   * at creation (ARCHITECTURE.md §10.5.14). Editable in Settings. Defaults
   * to ["numpy", "matplotlib"]. Editing it never changes existing projects.
   */
  defaultPackages?: string[];
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
  /**
   * Configurable external-app launchers — terminal emulator wrap for TUI
   * editors and the editor/IDE command today, plus (in a later milestone) an
   * AI-agent slot that shares the same infrastructure. See `editor-spawn.ts`.
   */
  launchers?: {
    /**
     * Terminal emulator used to wrap TUI editors (vim, nvim, …) and (later)
     * the AI-agent launch flow. When unset, the platform default is used:
     * Terminal.app on macOS, `x-terminal-emulator` on Linux, `wt.exe` on
     * Windows.
     */
    terminal?: TerminalLauncherConfig;
    /**
     * Editor / IDE commands. Supersedes the legacy `pythonEditorCmd` /
     * `juliaEditorCmd` keys (migrated automatically on first load).
     */
    editor?: EditorLauncherConfig;
    /** AI-agent CLI launched by the action-bar agent button. */
    agent?: AgentLauncherConfig;
  };
  /** AI agent integration (MCP server) settings. */
  mcp?: {
    /**
     * Preferred loopback port for the MCP server. The server falls back to
     * the next free port on collision. Defaults to {@link DEFAULT_MCP_PORT}.
     */
    defaultPort?: number;
    /**
     * Whether mutating MCP tools are exposed to connected agents. Off by
     * default; gated here until the project trust model lands (Phase 2).
     */
    mutatingToolsEnabled?: boolean;
    /**
     * Whether the `pdv_run` tool (arbitrary code in the live kernel) is
     * exposed. Off by default (Phase 2).
     */
    pdvRunEnabled?: boolean;
    /**
     * Bearer token authenticating MCP requests. Minted on first server
     * start and persisted so a connected agent survives an app restart
     * instead of failing auth against a freshly-rotated secret. Absent
     * until the MCP server has started at least once.
     */
    authToken?: string;
  };
  /** uv environment-manager settings (ARCHITECTURE.md §10.5). */
  uv?: {
    /**
     * Absolute path to a `uv` binary that overrides the one bundled with
     * the app. For developers who want PDV to use a system `uv`. Undefined
     * means use the bundled binary (§10.5.6).
     */
    binaryPath?: string;
  };
}

/**
 * Default autosave interval in seconds when neither config nor user input
 * supplies a value. Used as the `?? DEFAULT_AUTOSAVE_INTERVAL_S` fallback in
 * the autosave timer setup and the Settings dialog so the magic number lives
 * in exactly one place.
 */
export const DEFAULT_AUTOSAVE_INTERVAL_S = 300;

/**
 * Default loopback port for the AI-agent MCP server. The server falls back
 * to the next free port when this one is taken. Overridable via the
 * `mcp.defaultPort` config key.
 */
export const DEFAULT_MCP_PORT = 7391;

const CONFIG_DEFAULTS: PDVConfig = {
  showPrivateVariables: false,
  showModuleVariables: false,
  showCallableVariables: false,
  autoRefreshNamespace: false,
  autoSaveIntervalSeconds: DEFAULT_AUTOSAVE_INTERVAL_S,
  defaultPackages: ["numpy", "matplotlib"],
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
  for (const key of ["pythonEditorCmd", "juliaEditorCmd", "defaultSaveLocation", "workingDirBase"] as const) {
    if (key in obj) {
      const val = obj[key];
      if (val !== null && val !== undefined && typeof val !== "string") {
        throw new Error(`Invalid config value for ${key} in ${filePath}`);
      }
      if (typeof val === "string") result[key] = val;
    }
  }
  if ("autoSaveIntervalSeconds" in obj) {
    const val = obj.autoSaveIntervalSeconds;
    if (val !== null && val !== undefined && typeof val === "number" && val >= 30) {
      result.autoSaveIntervalSeconds = val;
    }
  }
  if ("defaultPackages" in obj) {
    const defaultPackages = obj.defaultPackages;
    if (defaultPackages !== null && defaultPackages !== undefined) {
      if (
        !Array.isArray(defaultPackages) ||
        !defaultPackages.every((entry) => typeof entry === "string")
      ) {
        throw new Error(`Invalid config value for defaultPackages in ${filePath}`);
      }
      result.defaultPackages = defaultPackages;
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
  if ("mcp" in obj) {
    const mcp = obj.mcp;
    if (mcp !== null && mcp !== undefined && (typeof mcp !== "object" || Array.isArray(mcp))) {
      throw new Error(`Invalid config value for mcp in ${filePath}`);
    }
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      result.mcp = mcp as PDVConfig["mcp"];
    }
  }
  if ("uv" in obj) {
    const uv = obj.uv;
    if (uv !== null && uv !== undefined && (typeof uv !== "object" || Array.isArray(uv))) {
      throw new Error(`Invalid config value for uv in ${filePath}`);
    }
    if (uv && typeof uv === "object" && !Array.isArray(uv)) {
      result.uv = uv as PDVConfig["uv"];
    }
  }
  if ("launchers" in obj) {
    const launchers = obj.launchers;
    if (launchers !== null && launchers !== undefined) {
      if (typeof launchers !== "object" || Array.isArray(launchers)) {
        throw new Error(`Invalid config value for launchers in ${filePath}`);
      }
      const parsed = parseLaunchers(launchers as Record<string, unknown>, filePath);
      if (parsed) result.launchers = parsed;
    }
  }

  return result;
}

/**
 * Validate the `launchers` config block. Unknown keys are dropped (forward
 * compatibility); malformed values raise an error so a corrupt file is
 * surfaced loudly rather than silently ignored.
 *
 * @param obj - Raw `launchers` object from the parsed JSON.
 * @param filePath - Config file path, used for error messages.
 * @returns The normalized `launchers` block, or `undefined` if no recognised
 *   keys were present.
 */
function parseLaunchers(
  obj: Record<string, unknown>,
  filePath: string,
): PDVConfig["launchers"] | undefined {
  const out: NonNullable<PDVConfig["launchers"]> = {};
  if ("terminal" in obj) {
    const terminal = obj.terminal;
    if (terminal !== null && terminal !== undefined) {
      if (typeof terminal !== "object" || Array.isArray(terminal)) {
        throw new Error(`Invalid config value for launchers.terminal in ${filePath}`);
      }
      const t = terminal as Record<string, unknown>;
      const preset = t.preset;
      if (typeof preset !== "string" || !TERMINAL_PRESET_SET.has(preset as TerminalPreset)) {
        throw new Error(
          `Invalid config value for launchers.terminal.preset in ${filePath}: ${String(preset)}`,
        );
      }
      const entry: TerminalLauncherConfig = { preset: preset as TerminalPreset };
      if (preset === "custom") {
        const customTemplate = t.customTemplate;
        if (customTemplate !== undefined && customTemplate !== null) {
          if (typeof customTemplate !== "string") {
            throw new Error(
              `Invalid config value for launchers.terminal.customTemplate in ${filePath}`,
            );
          }
          entry.customTemplate = customTemplate;
        }
      }
      out.terminal = entry;
    }
  }
  if ("editor" in obj) {
    const editor = obj.editor;
    if (editor !== null && editor !== undefined) {
      if (typeof editor !== "object" || Array.isArray(editor)) {
        throw new Error(`Invalid config value for launchers.editor in ${filePath}`);
      }
      const e = editor as Record<string, unknown>;
      const entry: EditorLauncherConfig = {};
      for (const key of ["fileCommand", "dirCommand"] as const) {
        const val = e[key];
        if (val !== undefined && val !== null) {
          if (typeof val !== "string") {
            throw new Error(`Invalid config value for launchers.editor.${key} in ${filePath}`);
          }
          entry[key] = val;
        }
      }
      if (e.isTuiEditor !== undefined && e.isTuiEditor !== null) {
        if (typeof e.isTuiEditor !== "boolean") {
          throw new Error(`Invalid config value for launchers.editor.isTuiEditor in ${filePath}`);
        }
        entry.isTuiEditor = e.isTuiEditor;
      }
      if (Object.keys(entry).length > 0) out.editor = entry;
    }
  }
  if ("agent" in obj) {
    const agent = obj.agent;
    if (agent !== null && agent !== undefined) {
      if (typeof agent !== "object" || Array.isArray(agent)) {
        throw new Error(`Invalid config value for launchers.agent in ${filePath}`);
      }
      const a = agent as Record<string, unknown>;
      const entry: AgentLauncherConfig = {};
      if (a.command !== undefined && a.command !== null) {
        if (typeof a.command !== "string") {
          throw new Error(`Invalid config value for launchers.agent.command in ${filePath}`);
        }
        entry.command = a.command;
      }
      if (a.cwd !== undefined && a.cwd !== null) {
        if (a.cwd !== "project" && a.cwd !== "working") {
          throw new Error(`Invalid config value for launchers.agent.cwd in ${filePath}`);
        }
        entry.cwd = a.cwd;
      }
      if (Object.keys(entry).length > 0) out.agent = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    this.migrateLegacyEditorCmd();
  }

  /**
   * One-shot migration from the legacy per-language editor keys
   * (`pythonEditorCmd` / `juliaEditorCmd`) to the unified
   * `launchers.editor.fileCommand` slot.
   *
   * Runs once at load: if a legacy key is present, its value seeds
   * `launchers.editor.fileCommand` (unless that is already set — the newer
   * value wins) and both legacy keys are dropped from the persisted file.
   * After it has run the config no longer carries the legacy keys, so on
   * every subsequent launch this is a cheap no-op with no disk write.
   *
   * @returns Nothing.
   * @throws {Error} When the rewritten config cannot be persisted.
   */
  private migrateLegacyEditorCmd(): void {
    const hasLegacy =
      this.state.pythonEditorCmd !== undefined ||
      this.state.juliaEditorCmd !== undefined;
    if (!hasLegacy) return;

    // Prefer the Python editor command; fall back to the Julia one so a
    // user who configured only `juliaEditorCmd` doesn't lose it.
    const legacyCmd = this.state.pythonEditorCmd ?? this.state.juliaEditorCmd;
    const alreadyMigrated =
      this.state.launchers?.editor?.fileCommand !== undefined;

    const next: Partial<PDVConfig> = { ...this.state };
    delete next.pythonEditorCmd;
    delete next.juliaEditorCmd;
    if (!alreadyMigrated && typeof legacyCmd === "string") {
      next.launchers = {
        ...next.launchers,
        editor: { ...next.launchers?.editor, fileCommand: legacyCmd },
      };
    }
    this.state = next;
    this.persist();
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

  // Persist current in-memory state to disk. Atomic (tmp + rename): a
  // crash mid-write must not tear preferences.json — the loader treats
  // an unparseable file as corrupt and resets ALL settings, including
  // the persisted MCP auth token.
  private persist(): void {
    atomicWriteFileSync(this.configPath, JSON.stringify(this.state, null, 2));
  }
}
