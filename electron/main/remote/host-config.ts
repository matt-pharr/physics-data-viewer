/**
 * host-config.ts — Per-host remote settings, persisted on the laptop.
 *
 * Everything PDV knows *about* a cluster that must survive being away from
 * it lives here: where working directories should go on that host, how a
 * kernel should be launched there, and which concrete login node the user's
 * session was last seen on. The file is `<userData>/remote-hosts.json`,
 * keyed by host alias — deliberately local (editable offline, survives
 * reinstalls on the cluster) and deliberately NOT part of `PDVConfig`:
 * these keys are per-host where the config split is per-side, and folding a
 * host-keyed table into `parseConfig`'s flat validation tables would invite
 * the drops-unknown-keys trap for every new field.
 *
 * The per-host setup script is NOT here — it is a sibling file per host
 * under `<userData>/remote-setup/` (`remote/setup-script.ts`), because
 * multi-line shell scripts do not belong inside JSON values.
 *
 * Two kinds of field share the file and must not be confused:
 *  - **Settings** the user edits in the Remote Hosts tab (directories,
 *    launch configuration). `setSettings` replaces these wholesale.
 *  - **Recorded state** PDV writes for itself (`sessionNode`, the concrete
 *    login node the session daemon lives on). `setSettings` preserves it;
 *    only `setSessionNode` touches it.
 *
 * This module does NOT apply any of these values — the registrar pushes the
 * directory keys into the remote server's config at session start, the
 * connection manager reads `sessionNode` to pin its master, and B5's Slurm
 * launch will read `launch` on the daemon side.
 */

import * as fs from "fs";
import * as path from "path";

import { atomicWriteFileSync } from "../atomic-write";
import type { RemoteHostLaunchConfig, RemoteHostSettings } from "../ipc";

/** Everything recorded for one host: settings plus PDV-recorded state. */
export interface RemoteHostRecord extends RemoteHostSettings {
  /**
   * Concrete node the session daemon was last started on (recorded at
   * session start, cleared when the session is shut down). A load-balanced
   * alias round-robins across login nodes while the session socket is
   * node-local, so a reconnect must aim at THIS machine, not the alias.
   */
  sessionNode?: string;
}

/** The keys `setSettings` owns; everything else is recorded state. */
const SETTINGS_KEYS = ["workingDirBase", "defaultSaveLocation", "launch"] as const;

/**
 * Validate one host's record from raw JSON.
 *
 * Lenient in the same way the config stores are: a malformed field is
 * dropped rather than failing the file, because losing every host's
 * settings over one bad value is the worse outcome.
 *
 * @param raw - Parsed JSON value for one host.
 * @returns The recognised subset, or null when nothing survives.
 */
function parseRecord(raw: unknown): RemoteHostRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out: RemoteHostRecord = {};
  for (const key of ["workingDirBase", "defaultSaveLocation", "sessionNode"] as const) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  const launch = obj.launch;
  if (launch && typeof launch === "object" && !Array.isArray(launch)) {
    const l = launch as Record<string, unknown>;
    if (l.mode === "login-node" || l.mode === "slurm") {
      const parsed: RemoteHostLaunchConfig = { mode: l.mode };
      for (const key of ["allocationCommand", "account", "partition"] as const) {
        const value = l[key];
        if (typeof value === "string" && value.trim()) parsed[key] = value;
      }
      out.launch = parsed;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Persistent store for per-host remote settings.
 *
 * Mirrors the other stores' contract: load once at construction, atomic
 * write on every change, move a corrupt file aside rather than crashing.
 */
export class RemoteHostStore {
  private readonly filePath: string;
  private hosts: Record<string, RemoteHostRecord>;

  /**
   * @param userDataDir - Electron's `userData` directory.
   * @throws {Error} When the directory cannot be created.
   */
  constructor(userDataDir: string) {
    fs.mkdirSync(userDataDir, { recursive: true });
    this.filePath = path.join(userDataDir, "remote-hosts.json");
    this.hosts = this.loadState();
  }

  /**
   * One host's record.
   *
   * @param host - Host alias as the user typed it.
   * @returns A snapshot; callers may not mutate it in place. Empty object
   *   when nothing is recorded for the host.
   */
  get(host: string): RemoteHostRecord {
    return { ...this.hosts[host] };
  }

  /**
   * Hosts that have anything recorded.
   *
   * @returns Aliases in file order.
   */
  listConfiguredHosts(): string[] {
    return Object.keys(this.hosts);
  }

  /**
   * Replace a host's user-editable settings, preserving recorded state.
   *
   * A full replace, not a merge: the settings tab always loads and submits
   * the complete settings shape, so an absent field means "cleared", and a
   * merge would make clearing a field impossible.
   *
   * @param host - Host alias.
   * @param settings - The complete new settings for this host.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  setSettings(host: string, settings: RemoteHostSettings): void {
    const next: RemoteHostRecord = {};
    const sessionNode = this.hosts[host]?.sessionNode;
    if (sessionNode) next.sessionNode = sessionNode;
    for (const key of SETTINGS_KEYS) {
      const value = settings[key];
      if (value !== undefined) {
        (next as Record<string, unknown>)[key] = value;
      }
    }
    // Re-validate through the same gate as a file load, so a bad value from
    // a caller is dropped now rather than silently persisted and dropped on
    // the next boot — the two paths must agree on what the file may hold.
    const parsed = parseRecord(next);
    if (parsed) this.hosts[host] = parsed;
    else delete this.hosts[host];
    this.persist();
  }

  /**
   * Record (or clear) the concrete node a host's session daemon lives on.
   *
   * @param host - Host alias.
   * @param node - Concrete hostname, or null to clear the pin.
   * @returns Nothing.
   * @throws {Error} When the file cannot be written.
   */
  setSessionNode(host: string, node: string | null): void {
    const record = this.hosts[host] ?? {};
    if (node && node.trim()) record.sessionNode = node.trim();
    else delete record.sessionNode;
    if (Object.keys(record).length > 0) this.hosts[host] = record;
    else delete this.hosts[host];
    this.persist();
  }

  // Read from disk; a corrupt file is moved aside so the next boot is clean.
  private loadState(): Record<string, RemoteHostRecord> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("remote-hosts.json must contain an object");
      }
      const out: Record<string, RemoteHostRecord> = {};
      for (const [host, raw] of Object.entries(parsed as Record<string, unknown>)) {
        const record = parseRecord(raw);
        if (record) out[host] = record;
      }
      return out;
    } catch (error) {
      console.error(
        `[pdv] failed to load ${this.filePath}; starting with no host settings.`,
        error,
      );
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupted-${String(Date.now())}`);
      } catch (renameError) {
        console.error("[pdv] could not back up the unreadable file", renameError);
      }
      return {};
    }
  }

  private persist(): void {
    atomicWriteFileSync(this.filePath, JSON.stringify(this.hosts, null, 2));
  }
}
