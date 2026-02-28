/**
 * project-manager.ts — Coordinates project open/save operations.
 *
 * Handles the multi-step save and load sequences described in
 * ARCHITECTURE.md §8, bridging between the Electron UI, IPC, and the kernel.
 *
 * Save coordination (ARCHITECTURE.md §8.1):
 * 1. App sends ``pdv.project.save`` comm → kernel writes tree + tree-index.json.
 * 2. Kernel responds with checksum.
 * 3. App writes code-cells.json.
 * 4. App writes project.json (only on full success).
 *
 * Load coordination (ARCHITECTURE.md §8.2):
 * 1. App sends ``pdv.project.load`` comm with save_dir.
 * 2. Kernel reads tree-index.json, populates lazy registry.
 * 3. Kernel pushes ``pdv.project.loaded`` notification.
 * 4. App reads code-cells.json.
 * 5. UI is unlocked.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §8 (save and load sequences)
 * ARCHITECTURE.md §6.2 (project save directory layout)
 * comm-router.ts — used to send pdv.project.save / pdv.project.load
 */

import { CommRouter } from "./comm-router";
import { PDVMessageType } from "./pdv-protocol";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted metadata stored in ``project.json`` alongside ``code-cells.json``.
 *
 * See ARCHITECTURE.md §8.1 for the full field semantics.
 */
export interface ProjectModuleImport {
  /** Stable installed module identifier. */
  module_id: string;
  /** Project-local alias used for tree binding. */
  alias: string;
  /** Imported module version snapshot. */
  version: string;
  /** Optional imported revision hash. */
  revision?: string;
}

/**
 * Persisted metadata stored in ``project.json`` alongside ``code-cells.json``.
 *
 * Includes per-project module import activation and module settings.
 */
export interface ProjectManifest {
  /** Schema version of project.json. */
  schema_version: string;
  /** ISO 8601 timestamp of last save. */
  saved_at: string;
  /** PDV protocol version used when saving. */
  pdv_version: string;
  /** SHA-256 checksum of tree-index.json. */
  tree_checksum: string;
  /** Imported modules active in this project. */
  modules: ProjectModuleImport[];
  /** Persisted per-module settings keyed by module alias. */
  module_settings: Record<string, Record<string, unknown>>;
}

/** Current schema major version. Increment on breaking changes to project.json. */
const SCHEMA_VERSION = "1.1";

/** Default manifest returned when project.json is missing (ARCHITECTURE.md §8). */
const DEFAULT_MANIFEST: ProjectManifest = {
  schema_version: SCHEMA_VERSION,
  saved_at: new Date(0).toISOString(),
  pdv_version: "1.0",
  tree_checksum: "",
  modules: [],
  module_settings: {},
};

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link ProjectManager.readManifest} when ``project.json`` contains
 * a schema major version newer than this app understands.
 */
export class PDVSchemaVersionError extends Error {
  /**
   * @param found - The schema version string read from project.json.
   * @param supported - The schema version this build supports.
   */
  constructor(
    public readonly found: string,
    public readonly supported: string
  ) {
    super(
      `Unsupported project.json schema version: ${found} ` +
        `(this app supports up to ${supported})`
    );
    this.name = "PDVSchemaVersionError";
  }
}

// ---------------------------------------------------------------------------
// ProjectManager
// ---------------------------------------------------------------------------

/**
 * Coordinates project save/load workflows between the app and kernel.
 *
 * Uses `CommRouter` for protocol requests and handles local manifest +
 * code-cell file persistence. It does NOT own renderer state updates.
 */
export class ProjectManager {
  /**
   * @param commRouter - CommRouter connected to the active kernel.
   */
  constructor(private readonly commRouter: CommRouter) {}

  /**
   * Create a uniquely named working directory under the OS temp directory.
   *
   * The caller (Electron main process) is responsible for deleting this
   * directory on clean shutdown. See ARCHITECTURE.md §6.1.
   *
   * @returns Absolute path to the newly created directory.
   */
  async createWorkingDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "pdv-"));
  }

  /**
   * Recursively delete a working directory created by {@link createWorkingDir}.
   *
   * @param dirPath - Absolute path to the directory to remove.
   */
  async deleteWorkingDir(dirPath: string): Promise<void> {
    await fs.rm(dirPath, { recursive: true, force: true });
  }

  /**
   * Save the current project to a directory.
   *
   * Implements the full save sequence from ARCHITECTURE.md §8.1:
   * 1. Send ``pdv.project.save`` comm and await the kernel's response.
   * 2. Write ``code-cells.json`` to ``saveDir``.
   * 3. Write ``project.json`` to ``saveDir`` (only on full success).
   *
   * If the kernel responds with ``status: 'error'``, this method re-throws
   * the comm error and does **not** write ``project.json``.
   *
   * @param saveDir - Absolute path to the project directory.
   * @param codeCells - The current code-cell state from the renderer.
   * @throws {PDVCommError} When the kernel responds with status='error'.
   */
  async save(saveDir: string, codeCells: unknown): Promise<void> {
    // Step 1 — send pdv.project.save comm; throws PDVCommError on error status.
    const response = await this.commRouter.request(PDVMessageType.PROJECT_SAVE, {
      save_dir: saveDir,
    });

    const payload = response.payload as { checksum?: string };
    const checksum = payload.checksum ?? "";

    // Step 2 — write code-cells.json.
    await fs.writeFile(
      path.join(saveDir, "code-cells.json"),
      JSON.stringify(codeCells, null, 2),
      "utf8"
    );

    // Step 3 — write project.json (only after both kernel and app state are flushed).
    // Preserve existing module imports and settings from a prior manifest if present.
    let existingModules: ProjectModuleImport[] = [];
    let existingModuleSettings: Record<string, Record<string, unknown>> = {};
    try {
      const existing = await ProjectManager.readManifest(saveDir);
      existingModules = existing.modules;
      existingModuleSettings = existing.module_settings;
    } catch {
      // No prior manifest or unreadable — start fresh.
    }
    const manifest: ProjectManifest = {
      schema_version: SCHEMA_VERSION,
      saved_at: new Date().toISOString(),
      pdv_version: "1.0",
      tree_checksum: checksum,
      modules: existingModules,
      module_settings: existingModuleSettings,
    };
    await fs.writeFile(
      path.join(saveDir, "project.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
  }

  /**
   * Load a project from a directory.
   *
   * Implements the load sequence from ARCHITECTURE.md §8.2:
   * 1. Send ``pdv.project.load`` comm with ``save_dir``.
   * 2. Wait for the ``pdv.project.loaded`` push notification.
   * 3. Read ``code-cells.json`` from ``saveDir``.
   *
   * @param saveDir - Absolute path to the project directory.
   * @returns The code-cell state read from ``code-cells.json``.
   * @throws {PDVCommError} When the kernel responds with status='error'.
   */
  async load(saveDir: string): Promise<unknown> {
    // Step 1 — register the push handler BEFORE sending the request so the
    // notification is never missed even if the kernel responds very quickly.
    const pushPromise = new Promise<void>((resolve) => {
      const handler = (): void => {
        this.commRouter.offPush(PDVMessageType.PROJECT_LOADED, handler);
        resolve();
      };
      this.commRouter.onPush(PDVMessageType.PROJECT_LOADED, handler);
    });

    // Step 2 — send pdv.project.load comm.
    // The request resolves when the kernel sends pdv.project.load.response.
    await this.commRouter.request(PDVMessageType.PROJECT_LOAD, {
      save_dir: saveDir,
    });

    // Step 3 — wait for the pdv.project.loaded push notification.
    await pushPromise;

    // Step 4 — read code-cells.json.
    return _readCodeCelles(saveDir);
  }

  /**
   * Read ``project.json`` from a directory and return the manifest.
   *
   * Does NOT send any comm messages or interact with the kernel.
   *
   * - If ``project.json`` is absent, returns {@link DEFAULT_MANIFEST} (no throw).
   * - If the schema major version is greater than this app supports, throws
   *   {@link PDVSchemaVersionError}.
   *
   * @param saveDir - Absolute path to the project directory.
   * @returns Parsed project manifest.
   * @throws {PDVSchemaVersionError} When the file's schema major version is
   *   incompatible with this build.
   */
  static async readManifest(saveDir: string): Promise<ProjectManifest> {
    const manifestPath = path.join(saveDir, "project.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return { ...DEFAULT_MANIFEST };
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`project.json is not valid JSON: ${manifestPath}`);
    }

    const obj = parsed as Record<string, unknown>;
    const schemaVersion = String(obj.schema_version ?? "1.0");
    _assertCompatibleSchema(schemaVersion);

    return {
      schema_version: schemaVersion,
      saved_at: String(obj.saved_at ?? DEFAULT_MANIFEST.saved_at),
      pdv_version: String(obj.pdv_version ?? DEFAULT_MANIFEST.pdv_version),
      tree_checksum: String(obj.tree_checksum ?? ""),
      modules: _parseManifestModules(obj.modules, manifestPath),
      module_settings: _parseModuleSettings(obj.module_settings, manifestPath),
    };
  }

  /**
   * Write a {@link ProjectManifest} to ``project.json`` in the given directory.
   *
   * @param saveDir - Absolute path to the project directory.
   * @param manifest - Manifest data to write.
   */
  static async saveManifest(
    saveDir: string,
    manifest: ProjectManifest
  ): Promise<void> {
    await fs.writeFile(
      path.join(saveDir, "project.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check that a schema version is compatible with this build.
 *
 * @param schemaVersion - Version string from project.json.
 * @throws {PDVSchemaVersionError} When the major version exceeds supported.
 */
function _assertCompatibleSchema(schemaVersion: string): void {
  const supportedMajor = Number(SCHEMA_VERSION.split(".")[0]);
  const foundMajor = Number(schemaVersion.split(".")[0]);
  if (isNaN(foundMajor) || foundMajor > supportedMajor) {
    throw new PDVSchemaVersionError(schemaVersion, SCHEMA_VERSION);
  }
}

/**
 * Parse `modules` from a project manifest payload.
 *
 * Missing field defaults to `[]` for backward compatibility.
 *
 * @param value - Raw `modules` field value.
 * @param manifestPath - Source manifest path for diagnostics.
 * @returns Parsed module import descriptors.
 * @throws {Error} When `modules` is present but invalid.
 */
function _parseManifestModules(
  value: unknown,
  manifestPath: string
): ProjectModuleImport[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`project.json field "modules" must be an array: ${manifestPath}`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `project.json field "modules[${index}]" must be an object: ${manifestPath}`
      );
    }
    const obj = entry as Record<string, unknown>;
    const moduleId = obj.module_id;
    const alias = obj.alias;
    const version = obj.version;
    const revision = obj.revision;
    if (typeof moduleId !== "string" || moduleId.trim().length === 0) {
      throw new Error(
        `project.json field "modules[${index}].module_id" must be a non-empty string: ${manifestPath}`
      );
    }
    if (typeof alias !== "string" || alias.trim().length === 0) {
      throw new Error(
        `project.json field "modules[${index}].alias" must be a non-empty string: ${manifestPath}`
      );
    }
    if (typeof version !== "string" || version.trim().length === 0) {
      throw new Error(
        `project.json field "modules[${index}].version" must be a non-empty string: ${manifestPath}`
      );
    }
    if (revision !== undefined && typeof revision !== "string") {
      throw new Error(
        `project.json field "modules[${index}].revision" must be a string: ${manifestPath}`
      );
    }
    return {
      module_id: moduleId.trim(),
      alias: alias.trim(),
      version: version.trim(),
      revision: typeof revision === "string" ? revision : undefined,
    };
  });
}

/**
 * Parse `module_settings` from a project manifest payload.
 *
 * Missing field defaults to `{}` for backward compatibility.
 *
 * @param value - Raw `module_settings` field value.
 * @param manifestPath - Source manifest path for diagnostics.
 * @returns Parsed module settings map.
 * @throws {Error} When `module_settings` is present but invalid.
 */
function _parseModuleSettings(
  value: unknown,
  manifestPath: string
): Record<string, Record<string, unknown>> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `project.json field "module_settings" must be an object: ${manifestPath}`
    );
  }
  const settings = value as Record<string, unknown>;
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [alias, aliasSettings] of Object.entries(settings)) {
    if (!aliasSettings || typeof aliasSettings !== "object" || Array.isArray(aliasSettings)) {
      throw new Error(
        `project.json field "module_settings.${alias}" must be an object: ${manifestPath}`
      );
    }
    normalized[alias] = aliasSettings as Record<string, unknown>;
  }
  return normalized;
}

/**
 * Read and parse ``code-cells.json`` from a project directory.
 *
 * Returns an empty array if the file does not exist.
 *
 * @param saveDir - Absolute path to the project directory.
 * @returns Parsed code-cell array, or ``[]`` when the file is absent.
 */
async function _readCodeCelles(saveDir: string): Promise<unknown> {
  const filePath = path.join(saveDir, "code-cells.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { tabs: [], activeTabId: 1 };
    throw err;
  }
}
