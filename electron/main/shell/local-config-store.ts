/**
 * local-config-store.ts — Shell-side persistence for the config keys that
 * belong to this machine rather than to the session's server.
 *
 * A session's server owns `~/.PDV/preferences.json`. Once that server can
 * be somewhere other than this laptop, every key in it becomes a property of
 * *that host* — which is right for `pythonPath` or `workingDirBase`, and
 * badly wrong for your theme, keybindings and editor command. Those follow
 * the person, not the machine their kernel happens to run on, so they live
 * here instead, in `<userData>/ui-preferences.json`.
 *
 * Responsibilities
 * - Own {@link LOCAL_CONFIG_KEYS} — the authoritative ownership table.
 * - Persist them atomically, tolerating a corrupt file the same way
 *   `config.ts` does (move it aside, carry on with defaults).
 * - Seed itself once from a server config that predates the split, so an
 *   existing install keeps its theme and launchers.
 *
 * What it does NOT do
 * - It does not merge the two halves or serve `config:*` — `shell/config-bridge.ts`
 *   does, and it is the only thing that should read this class directly.
 * - It does not hold session keys. Anything the *server* reads for itself
 *   (`pythonPath`, `workingDirBase`, `defaultPackages`, `uv`, and `mcp` —
 *   whose bearer token is minted and validated server-side) stays there.
 *
 * See Also
 * --------
 * config.ts — the server-side store and the full `PDVConfig` schema
 * shell/config-bridge.ts — merges both halves behind the unchanged `config:*` API
 */

import * as fs from "fs";
import * as path from "path";

import { atomicWriteFileSync } from "../atomic-write";
import { normalizeRecentProjects, type PDVConfig } from "../config";

/**
 * Config keys owned by the shell rather than the session's server.
 *
 * Membership rule: a key belongs here if the *server* never reads it for
 * itself. Everything on this list is consumed only by the renderer or by
 * shell-side code (window chrome, menus, local process launchers, the
 * updater), which is why it can follow the user across hosts.
 *
 * `mcp` is deliberately absent despite being a UI-ish concern: the server
 * mints and validates its bearer token and gates tool exposure on it
 * (`mcp/mcp-server.ts`, `mcp/tools/_helpers.ts`).
 */
export const LOCAL_CONFIG_KEYS = [
  "theme",
  "settings",
  "launchers",
  "lastUpdateCheck",
  "recentProjects",
] as const;

/** A key owned by {@link LocalConfigStore}. */
export type LocalConfigKey = (typeof LOCAL_CONFIG_KEYS)[number];

/** The shell-owned slice of {@link PDVConfig}. */
export type LocalConfig = Pick<PDVConfig, LocalConfigKey>;

const LOCAL_KEY_SET: ReadonlySet<string> = new Set(LOCAL_CONFIG_KEYS);

/**
 * Whether a config key is owned by the shell.
 *
 * @param key - Any `PDVConfig` top-level key.
 * @returns True when {@link LocalConfigStore} owns it.
 */
export function isLocalConfigKey(key: string): key is LocalConfigKey {
  return LOCAL_KEY_SET.has(key);
}

/**
 * Split a config patch into its shell-owned and server-owned halves.
 *
 * @param updates - A partial config as the renderer sent it.
 * @returns The two halves; either may be empty.
 */
export function partitionConfigUpdates(updates: Partial<PDVConfig>): {
  local: Partial<LocalConfig>;
  server: Partial<PDVConfig>;
} {
  const local: Record<string, unknown> = {};
  const server: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (isLocalConfigKey(key)) local[key] = value;
    else server[key] = value;
  }
  return {
    local: local as Partial<LocalConfig>,
    server: server as Partial<PDVConfig>,
  };
}

/**
 * Validate the shell-owned keys of a raw JSON object.
 *
 * Deliberately lenient in the same way `config.ts` is: an unrecognised or
 * malformed value is dropped rather than failing the whole load, because
 * losing every UI preference over one bad key is a far worse outcome than
 * silently reverting that key to its default.
 *
 * @param obj - Parsed JSON object.
 * @returns The recognised subset.
 */
function parseLocalConfig(obj: Record<string, unknown>): Partial<LocalConfig> {
  const out: Record<string, unknown> = {};
  if (obj.theme === "light" || obj.theme === "dark") out.theme = obj.theme;
  for (const key of ["settings", "launchers"] as const) {
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = value;
    }
  }
  if (typeof obj.lastUpdateCheck === "number") {
    out.lastUpdateCheck = obj.lastUpdateCheck;
  }
  if (Array.isArray(obj.recentProjects)) {
    // Tolerates the legacy `string[]` form written before recents were
    // host-qualified, so an existing list survives the upgrade.
    out.recentProjects = normalizeRecentProjects(obj.recentProjects);
  }
  return out as Partial<LocalConfig>;
}

/**
 * Persistent store for the shell-owned config keys.
 *
 * Mirrors `ConfigStore`'s contract (cache at construction, atomic write on
 * every change) so the two halves behave identically from the renderer's
 * side of the merge.
 */
export class LocalConfigStore {
  private readonly configPath: string;
  private state: Partial<LocalConfig>;

  /**
   * @param userDataDir - Electron's `userData` directory. Deliberately not
   *   `~/.PDV`, which the server owns and which on a remote session is the
   *   *cluster's* home directory.
   * @throws {Error} When the directory cannot be created.
   */
  constructor(userDataDir: string) {
    fs.mkdirSync(userDataDir, { recursive: true });
    this.configPath = path.join(userDataDir, "ui-preferences.json");
    this.state = this.loadState();
  }

  /** Whether a preferences file existed on disk when this store loaded. */
  get isSeeded(): boolean {
    return fs.existsSync(this.configPath);
  }

  /**
   * Current shell-owned values.
   *
   * @returns A snapshot; callers may not mutate it in place.
   */
  getAll(): Partial<LocalConfig> {
    return { ...this.state };
  }

  /**
   * Apply a patch, shallow-merging `settings` and `launchers`.
   *
   * Those two are merged rather than replaced for the same reason the
   * server's `config:set` merges them: a caller may send only
   * `launchers.terminal`, and a full replace would silently drop the
   * sibling `editor` and `agent` slots.
   *
   * @param updates - Shell-owned keys to change. `undefined` values are
   *   ignored, matching the server-side setter.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  apply(updates: Partial<LocalConfig>): void {
    const next: Record<string, unknown> = { ...this.state };
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      if (
        (key === "settings" || key === "launchers") &&
        value !== null &&
        typeof value === "object"
      ) {
        const existing = (next[key] ?? {}) as Record<string, unknown>;
        next[key] = { ...existing, ...(value as Record<string, unknown>) };
      } else {
        next[key] = value;
      }
    }
    this.state = next as Partial<LocalConfig>;
    this.persist();
  }

  /**
   * One-shot seed from a pre-split server config.
   *
   * On an existing install every shell-owned key still lives in the
   * server's `preferences.json`; without this the user's theme, keybindings
   * and editor command would silently revert to defaults on first launch
   * after the split. Does nothing once a local file exists, so it cannot
   * later clobber a value the user has since changed.
   *
   * The server's copies are left in place rather than deleted: they are
   * shadowed by this store from now on, and removing them would need a
   * delete path the config API does not have (`config:set` skips
   * `undefined`).
   *
   * @param serverConfig - The server's full config snapshot.
   * @returns True when a seed was written.
   */
  seedFrom(serverConfig: PDVConfig): boolean {
    if (this.isSeeded) return false;
    const inherited: Record<string, unknown> = {};
    for (const key of LOCAL_CONFIG_KEYS) {
      const value = serverConfig[key];
      if (value !== undefined) inherited[key] = value;
    }
    this.state = inherited as Partial<LocalConfig>;
    this.persist();
    console.log(
      `[pdv] seeded ${this.configPath} from the server config ` +
        `(${String(Object.keys(inherited).length)} keys)`
    );
    return true;
  }

  // Read from disk; a corrupt file is moved aside so the next boot is clean.
  private loadState(): Partial<LocalConfig> {
    if (!fs.existsSync(this.configPath)) return {};
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.configPath, "utf8")
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("ui-preferences.json must contain an object");
      }
      return parseLocalConfig(parsed as Record<string, unknown>);
    } catch (error) {
      console.error(
        `[pdv] failed to load ${this.configPath}; falling back to defaults.`,
        error
      );
      try {
        fs.renameSync(
          this.configPath,
          `${this.configPath}.corrupted-${String(Date.now())}`
        );
      } catch (renameError) {
        console.error("[pdv] could not back up the unreadable file", renameError);
      }
      return {};
    }
  }

  private persist(): void {
    atomicWriteFileSync(this.configPath, JSON.stringify(this.state, null, 2));
  }
}
