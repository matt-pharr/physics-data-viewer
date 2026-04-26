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
 * 2. Kernel reads tree-index.json, rebuilds the in-memory tree.
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
import { PDVMessageType, getAppVersion, type PDVProjectLoadResponsePayload } from "./pdv-protocol";
import type { CodeCellData } from "./ipc";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";


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
  /**
   * How this module entered the project.
   *
   * - ``"imported"`` (default): copied from the global store via
   *   ``modules:importToProject``.
   * - ``"in_session"``: authored in-app via ``modules:createEmpty``
   *   (workflow B of the #140 module editing workflow). On project load,
   *   in-session modules are restored from ``<saveDir>/modules/<id>/``
   *   since they have no upstream install path to fall back to.
   */
  origin?: "imported" | "in_session";
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
  /** XXH3-128 content-based checksum of the tree. */
  tree_checksum: string;
  /** Kernel language used by this project ("python" or "julia"). */
  language: "python" | "julia";
  /**
   * Absolute path to the interpreter executable used when last saved.
   * Populated at save time so that re-opening the project can pre-select
   * the same environment without requiring the user to reconfigure.
   */
  interpreter_path?: string;
  /**
   * Human-readable project name chosen by the user at save time.
   * Used in the title bar and recent projects list. Falls back to the
   * directory name when absent (backward compatibility with older saves).
   */
  project_name?: string;
  /** Imported modules active in this project. */
  modules: ProjectModuleImport[];
  /** Persisted per-module settings keyed by module alias. */
  module_settings: Record<string, Record<string, unknown>>;
}

/**
 * A file-backed tree node that belongs to a ``PDVModule`` and therefore
 * needs to be mirrored from the working directory back into
 * ``<saveDir>/modules/<module_id>/<source_rel_path>`` during save.
 *
 * Emitted by the kernel's ``handle_project_save`` in the save response,
 * consumed by the project:save IPC handler. See ARCHITECTURE.md §5.13
 * and the #140 module editing workflow plan §3.
 */
export interface ModuleOwnedFile {
  /** Owning module's stable id (matches ``<saveDir>/modules/<id>/``). */
  module_id: string;
  /** Path of the file relative to its module root, e.g. ``scripts/run.py``. */
  source_rel_path: string;
  /** Absolute on-disk path of the file as it currently exists in the working directory. */
  workdir_path: string;
}

/**
 * Per-module manifest bundle emitted by the kernel's ``project:save`` handler.
 *
 * Used by ``ipc-register-project.ts`` to write ``pdv-module.json`` and
 * ``module-index.json`` into ``<saveDir>/modules/<module_id>/`` so that
 * an in-session module can be rebound at project-load time via the
 * existing v4 bind path, and so that a subsequent export (§9) can
 * publish the module to the global store. See the #140 workflow plan §7.
 */
export interface ModuleManifestBundle {
  module_id: string;
  name: string;
  version: string;
  description?: string;
  language?: "python" | "julia";
  dependencies?: Array<Record<string, unknown>>;
  /**
   * Module-root-relative node descriptors — the same shape used in the
   * v4 ``module-index.json`` format consumed by ``bindImportedModule``.
   */
  entries: Array<Record<string, unknown>>;
}

/** Current schema major version. Increment on breaking changes to project.json. */
const SCHEMA_VERSION = "1.1";

/** Default manifest returned when project.json is missing (ARCHITECTURE.md §8). */
function defaultManifest(): ProjectManifest {
  return {
    schema_version: SCHEMA_VERSION,
    saved_at: new Date(0).toISOString(),
    pdv_version: getAppVersion(),
    tree_checksum: "",
    language: "python",
    modules: [],
    module_settings: {},
  };
}

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

/**
 * Validate that a value conforms to the {@link CodeCellData} shape.
 *
 * Used by {@link ProjectManager.save} to refuse nullish or malformed
 * payloads before they are serialized into ``code-cells.json``. A prior
 * bug (audit item #5) allowed ``undefined`` cells to silently clobber a
 * project's saved tabs — this validator is the boundary check.
 *
 * @param value - Unknown payload from an IPC caller.
 * @throws {Error} If the value is not a well-formed CodeCellData object.
 */
export function assertCodeCellData(value: unknown): asserts value is CodeCellData {
  if (value == null || typeof value !== "object") {
    throw new Error(
      "project.save: codeCells payload must be a CodeCellData object, got " +
        (value === null ? "null" : typeof value)
    );
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.tabs)) {
    throw new Error("project.save: codeCells.tabs must be an array");
  }
  if (typeof obj.activeTabId !== "number") {
    throw new Error("project.save: codeCells.activeTabId must be a number");
  }
  for (const [i, tab] of obj.tabs.entries()) {
    if (!tab || typeof tab !== "object") {
      throw new Error(`project.save: codeCells.tabs[${i}] must be an object`);
    }
    const t = tab as Record<string, unknown>;
    if (typeof t.id !== "number" || typeof t.code !== "string") {
      throw new Error(
        `project.save: codeCells.tabs[${i}] must have numeric id and string code`
      );
    }
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

  /**
   * Pre-computed kernel serialization results, keyed by saveDir.
   *
   * Populated by the ``pdv.project.save_completed`` push handler when
   * the kernel serializes the tree synchronously (Python-initiated saves).
   * Consumed once by the next ``save()`` call for the same directory.
   */
  private readonly _cachedKernelResults = new Map<string, {
    checksum: string;
    nodeCount: number;
    moduleOwnedFiles: ModuleOwnedFile[];
    moduleManifests: ModuleManifestBundle[];
  }>();

  /**
   * Cache kernel serialization results from a ``pdv.project.save_completed``
   * push so the next ``save()`` call can skip the comm round-trip.
   *
   * @param saveDir - Absolute path the kernel serialized to.
   * @param results - Serialization outputs from the kernel.
   */
  cacheKernelSaveResults(
    saveDir: string,
    results: {
      checksum: string;
      nodeCount: number;
      moduleOwnedFiles: ModuleOwnedFile[];
      moduleManifests: ModuleManifestBundle[];
    },
  ): void {
    this._cachedKernelResults.set(saveDir, results);
  }

  /**
   * Drop any cached kernel serialization results.
   *
   * Called on kernel stop so stale entries from abandoned
   * Python-initiated saves don't survive into a new session.
   */
  clearCachedKernelResults(): void {
    this._cachedKernelResults.clear();
  }

  async save(
    saveDir: string,
    codeCells: CodeCellData,
    options?: { language?: "python" | "julia"; interpreterPath?: string; projectName?: string }
  ): Promise<{
    checksum: string;
    nodeCount: number;
    moduleOwnedFiles: ModuleOwnedFile[];
    moduleManifests: ModuleManifestBundle[];
  }> {
    assertCodeCellData(codeCells);

    const t0 = performance.now();

    await fs.mkdir(saveDir, { recursive: true });

    // Use cached results from a kernel-initiated save (pdv.save_project())
    // to avoid the comm round-trip that deadlocks while the shell is busy.
    const cached = this._cachedKernelResults.get(saveDir);
    let checksum: string;
    let nodeCount: number;
    let moduleOwnedFiles: ModuleOwnedFile[];
    let moduleManifests: ModuleManifestBundle[];

    if (cached) {
      this._cachedKernelResults.delete(saveDir);
      console.debug(`[ProjectManager.save] using cached kernel results for ${saveDir}`);
      ({ checksum, nodeCount, moduleOwnedFiles, moduleManifests } = cached);
    } else {
      console.debug(`[ProjectManager.save] sending pdv.project.save comm (+${(performance.now() - t0).toFixed(0)}ms)`);
      const response = await this.commRouter.request(PDVMessageType.PROJECT_SAVE, {
        save_dir: saveDir,
      }, { keepAlivePushType: PDVMessageType.PROGRESS });
      console.debug(`[ProjectManager.save] kernel responded (+${(performance.now() - t0).toFixed(0)}ms)`);

      const payload = response.payload as {
        checksum?: string;
        node_count?: number;
        module_owned_files?: ModuleOwnedFile[];
        module_manifests?: ModuleManifestBundle[];
      };
      checksum = payload.checksum ?? "";
      nodeCount = payload.node_count ?? 0;
      moduleOwnedFiles = Array.isArray(payload.module_owned_files)
        ? payload.module_owned_files
        : [];
      moduleManifests = Array.isArray(payload.module_manifests)
        ? payload.module_manifests
        : [];
    }

    await fs.writeFile(
      path.join(saveDir, "code-cells.json"),
      JSON.stringify(codeCells, null, 2),
      "utf8"
    );

    let existingModules: ProjectModuleImport[] = [];
    let existingModuleSettings: Record<string, Record<string, unknown>> = {};
    let projectName = options?.projectName;
    try {
      const existing = await ProjectManager.readManifest(saveDir);
      existingModules = existing.modules;
      existingModuleSettings = existing.module_settings;
      if (projectName === undefined) {
        projectName = existing.project_name;
      }
    } catch {
      // No prior manifest or unreadable — start fresh.
    }
    const manifest: ProjectManifest = {
      schema_version: SCHEMA_VERSION,
      saved_at: new Date().toISOString(),
      pdv_version: getAppVersion(),
      tree_checksum: checksum,
      language: options?.language ?? "python",
      interpreter_path: options?.interpreterPath,
      project_name: projectName,
      modules: existingModules,
      module_settings: existingModuleSettings,
    };
    await fs.writeFile(
      path.join(saveDir, "project.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
    console.debug(`[ProjectManager.save] DONE (+${(performance.now() - t0).toFixed(0)}ms)`);

    return { checksum, nodeCount, moduleOwnedFiles, moduleManifests };
  }

  /**
   * Load a project from a directory.
   *
   * Implements the load sequence from ARCHITECTURE.md §8.2:
   * 1. Send ``pdv.project.load`` comm with ``save_dir``.
   * 2. Wait for the ``pdv.project.loaded`` push notification.
   * 3. Read ``code-cells.json`` from ``saveDir``.
   *
   * The caller is responsible for copying files into the working directory
   * before calling this method, and for running module setup after.
   *
   * @param saveDir - Absolute path to the project directory.
   * @returns The code-cell state and post-load checksum from the kernel.
   * @throws {PDVCommError} When the kernel responds with status='error'.
   */
  async load(saveDir: string): Promise<{ codeCells: unknown; postLoadChecksum: string | null }> {
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
    // Use progress pushes as keep-alive to prevent timeout during large loads.
    const response = await this.commRouter.request(PDVMessageType.PROJECT_LOAD, {
      save_dir: saveDir,
    }, { keepAlivePushType: PDVMessageType.PROGRESS });

    const loadPayload = response.payload as unknown as PDVProjectLoadResponsePayload;
    const postLoadChecksum = loadPayload?.post_load_checksum ?? null;

    // Step 3 — wait for the pdv.project.loaded push notification.
    await pushPromise;

    // Step 4 — read code-cells.json.
    const codeCells = await _readCodeCells(saveDir);
    return { codeCells, postLoadChecksum };
  }

  /**
   * Read ``project.json`` from a directory and return the manifest.
   *
   * Does NOT send any comm messages or interact with the kernel.
   *
   * - If ``project.json`` is absent, returns a default manifest (no throw).
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
        return { ...defaultManifest() };
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

    const rawLanguage = obj.language;
    const language: "python" | "julia" =
      rawLanguage === "julia" ? "julia" : "python";
    const interpreterPath =
      typeof obj.interpreter_path === "string" ? obj.interpreter_path : undefined;
    const projectName =
      typeof obj.project_name === "string" ? obj.project_name : undefined;

    return {
      schema_version: schemaVersion,
      saved_at: String(obj.saved_at ?? new Date(0).toISOString()),
      pdv_version: String(obj.pdv_version ?? getAppVersion()),
      tree_checksum: String(obj.tree_checksum ?? ""),
      language,
      interpreter_path: interpreterPath,
      project_name: projectName,
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
async function _readCodeCells(saveDir: string): Promise<unknown> {
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
