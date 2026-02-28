/**
 * module-manager.ts — Global module store install/list manager.
 *
 * Owns module installation into a shared on-disk store under `<pdvDir>/modules`,
 * including manifest validation and deterministic metadata indexing.
 *
 * Responsibilities:
 * - Install modules from GitHub URLs or local directories.
 * - Parse and validate `pdv-module.json`.
 * - Persist installed module metadata in a local index.
 * - Return normalized descriptors for renderer/UI consumption.
 *
 * Non-responsibilities:
 * - Project-scoped import activation (handled by project/import flows).
 * - Module action execution wiring.
 * - Dependency auto-installation.
 */

import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

import type {
  ModuleDescriptor,
  ModuleHealthWarning,
  ModuleInstallRequest,
  ModuleInstallResult,
  ModuleSourceReference,
  ModuleUpdateResult,
} from "./ipc";

const execFileAsync = promisify(execFile);

/** Current on-disk metadata index schema version. */
const MODULE_INDEX_SCHEMA_VERSION = "1.0";

/** Name of the required module manifest file. */
const MODULE_MANIFEST_FILE = "pdv-module.json";

/**
 * Raw module manifest shape accepted by v1 validation.
 */
interface ModuleManifestV1 {
  schema_version: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  compatibility?: {
    pdv_min?: string;
    pdv_max?: string;
    python?: string;
    python_min?: string;
    python_max?: string;
  };
  dependencies?: Array<{
    name: string;
    version?: string;
    marker?: string;
  }>;
  actions: Array<{
    id: string;
    label: string;
    script_path: string;
  }>;
}

/**
 * One script binding derived from a module manifest action list.
 */
export interface ModuleScriptBinding {
  /** Stable action identifier from manifest. */
  actionId: string;
  /** User-facing action label from manifest. */
  actionLabel: string;
  /** Script node name under `<alias>.scripts.<name>`. */
  name: string;
  /** Absolute path to the backing Python script file. */
  scriptPath: string;
}

/**
 * Metadata record persisted per installed module.
 */
interface StoredModuleRecord extends ModuleDescriptor {
  installed_at: string;
  updated_at: string;
}

/**
 * Top-level persisted metadata index for the module store.
 */
interface ModuleStoreIndex {
  schema_version: string;
  modules: Record<string, StoredModuleRecord>;
  history: Array<{
    timestamp: string;
    module_id: string;
    version: string;
    revision?: string;
    source: ModuleSourceReference;
    action: "installed" | "updated" | "update_check";
    outcome?: ModuleInstallResult["status"];
  }>;
}

/**
 * Manage the global modules store under `<pdvDir>/modules`.
 */
export class ModuleManager {
  private readonly modulesRoot: string;
  private readonly packagesRoot: string;
  private readonly indexPath: string;

  /**
   * @param pdvDir - PDV application data root (e.g. `~/.PDV`).
   */
  constructor(private readonly pdvDir: string) {
    this.modulesRoot = path.join(this.pdvDir, "modules");
    this.packagesRoot = path.join(this.modulesRoot, "packages");
    this.indexPath = path.join(this.modulesRoot, "index.json");
  }

  /**
   * List installed modules from the persisted metadata index.
   *
   * @returns Installed module descriptors sorted by name then id.
   * @throws {Error} When the metadata index exists but is invalid.
   */
  async listInstalled(): Promise<ModuleDescriptor[]> {
    const index = await this.readIndex();
    const descriptors = Object.values(index.modules).map((record) =>
      this.toDescriptor(record)
    );
    descriptors.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.id.localeCompare(b.id);
    });
    return descriptors;
  }

  /**
   * Install (or update) a module from a local path or GitHub URL.
   *
   * Duplicate installs do not overwrite existing files in place; instead this
   * method returns an explicit update state (`up_to_date`, `update_available`,
   * `incompatible_update`) so callers can run a user-confirmed update flow.
   *
   * @param request - Install request payload with source information.
   * @returns Installation result.
   */
  async install(request: ModuleInstallRequest): Promise<ModuleInstallResult> {
    try {
      await this.ensureStoreDirs();
      if (request.source.type === "local") {
        return await this.installFromLocalSource(request.source);
      }
      if (request.source.type === "github") {
        return await this.installFromGithubSource(request.source);
      }
      return {
        success: false,
        status: "error",
        error: `Unsupported module source type: ${request.source.type}`,
      };
    } catch (error) {
      return {
        success: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check updates for one installed module.
   *
   * v1 currently returns a not-implemented status and does not query remotes.
   *
   * @param moduleId - Installed module id.
   * @returns Update status payload.
   */
  async checkUpdates(moduleId: string): Promise<ModuleUpdateResult> {
    const index = await this.readIndex();
    const entry = index.modules[moduleId];
    if (!entry) {
      return {
        moduleId,
        status: "unknown",
        message: `Module not installed: ${moduleId}`,
      };
    }
    return {
      moduleId,
      status: "not_implemented",
      currentVersion: entry.version,
      message: "Remote update checks are not implemented yet.",
    };
  }

  /**
   * Resolve canonical script bindings for one installed module.
   *
   * @param moduleId - Installed module identifier.
   * @returns Canonical script bindings derived from manifest actions.
   * @throws {Error} When the module or any referenced script path is invalid.
   */
  async resolveActionScripts(moduleId: string): Promise<ModuleScriptBinding[]> {
    const index = await this.readIndex();
    const module = index.modules[moduleId];
    if (!module) {
      throw new Error(`Installed module not found: ${moduleId}`);
    }
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    const manifest = await this.readAndValidateManifest(moduleDir);
    const usedNames = new Set<string>();
    const bindings: ModuleScriptBinding[] = [];
    for (const action of manifest.actions) {
      const scriptPath = path.resolve(moduleDir, action.script_path);
      let scriptStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        scriptStat = await fs.stat(scriptPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          throw new Error(
            `Module action script does not exist: ${action.script_path} (${moduleId})`
          );
        }
        throw error;
      }
      if (!scriptStat.isFile()) {
        throw new Error(
          `Module action script is not a file: ${action.script_path} (${moduleId})`
        );
      }
      const requestedName = sanitizeScriptNodeName(
        path.parse(action.script_path).name || action.id
      );
      let uniqueName = requestedName;
      let suffix = 1;
      while (usedNames.has(uniqueName)) {
        uniqueName = `${requestedName}_${suffix}`;
        suffix += 1;
      }
      usedNames.add(uniqueName);
      bindings.push({
        actionId: action.id,
        actionLabel: action.label,
        name: uniqueName,
        scriptPath,
      });
    }
    return bindings;
  }

  /**
   * Evaluate non-blocking health warnings for one installed module.
   *
   * @param moduleId - Installed module identifier.
   * @param context - Runtime compatibility context.
   * @returns Warning list (empty when no issues detected).
   * @throws {Error} When the manifest exists but is structurally invalid.
   */
  async evaluateHealth(
    moduleId: string,
    context: { pdvVersion: string; pythonVersion?: string }
  ): Promise<ModuleHealthWarning[]> {
    const index = await this.readIndex();
    const module = index.modules[moduleId];
    if (!module) {
      return [
        {
          code: "module_source_missing",
          message: `Installed module not found: ${moduleId}`,
        },
      ];
    }
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    let manifest: ModuleManifestV1;
    try {
      manifest = await this.readAndValidateManifest(moduleDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(`Missing ${MODULE_MANIFEST_FILE}`)) {
        return [
          {
            code: "module_source_missing",
            message: `Module manifest missing for "${moduleId}"`,
          },
        ];
      }
      throw error;
    }

    const warnings: ModuleHealthWarning[] = [];
    const compatibility = manifest.compatibility;
    if (compatibility?.pdv_min && isVersionLessThan(context.pdvVersion, compatibility.pdv_min)) {
      warnings.push({
        code: "pdv_version_incompatible",
        message: `PDV ${context.pdvVersion} is below required minimum ${compatibility.pdv_min}`,
      });
    }
    if (compatibility?.pdv_max && isVersionGreaterThan(context.pdvVersion, compatibility.pdv_max)) {
      warnings.push({
        code: "pdv_version_incompatible",
        message: `PDV ${context.pdvVersion} is above supported maximum ${compatibility.pdv_max}`,
      });
    }

    const hasPythonConstraint = Boolean(
      compatibility?.python ||
        compatibility?.python_min ||
        compatibility?.python_max
    );
    if (hasPythonConstraint) {
      if (!context.pythonVersion) {
        warnings.push({
          code: "python_version_unknown",
          message:
            "Unable to verify Python compatibility because no Python version is available",
        });
      } else if (!isPythonVersionCompatible(context.pythonVersion, compatibility ?? {})) {
        warnings.push({
          code: "python_version_incompatible",
          message: `Python ${context.pythonVersion} is outside declared compatibility constraints`,
        });
      }
    }

    for (const dep of manifest.dependencies ?? []) {
      if (dep.version && dep.version.trim().length > 0) {
        warnings.push({
          code: "dependency_unverified",
          message: `Dependency requirement not auto-validated: ${dep.name} ${dep.version}`,
        });
      }
    }

    for (const action of manifest.actions) {
      const scriptPath = path.resolve(moduleDir, action.script_path);
      try {
        const stat = await fs.stat(scriptPath);
        if (!stat.isFile()) {
          warnings.push({
            code: "missing_action_script",
            message: `Action script is not a file: ${action.script_path}`,
          });
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          warnings.push({
            code: "missing_action_script",
            message: `Action script not found: ${action.script_path}`,
          });
          continue;
        }
        throw error;
      }
    }

    return warnings;
  }

  /**
   * Install from a local folder path.
   *
   * @param source - Local source reference.
   * @returns Installation result.
   */
  private async installFromLocalSource(
    source: ModuleSourceReference
  ): Promise<ModuleInstallResult> {
    const index = await this.readIndex();
    const sourceDir = path.resolve(source.location);
    const sourceStat = await fs.stat(sourceDir);
    if (!sourceStat.isDirectory()) {
      throw new Error(`Local module source is not a directory: ${sourceDir}`);
    }

    const stagingDir = await fs.mkdtemp(path.join(this.modulesRoot, "stage-local-"));
    let didMoveStaging = false;
    try {
      await fs.cp(sourceDir, stagingDir, { recursive: true, errorOnExist: false });
      const manifest = await this.readAndValidateManifest(stagingDir);
      const moduleDir = path.join(this.packagesRoot, manifest.id);
      const normalizedSource: ModuleSourceReference = {
        type: "local",
        location: sourceDir,
      };
      const descriptor: ModuleDescriptor = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        source: normalizedSource,
        installPath: moduleDir,
      };
      const previous = index.modules[manifest.id];
      if (previous) {
        const status = this.duplicateInstallStatus(previous, descriptor);
        this.recordUpdateCheck(index, descriptor, status);
        await this.writeIndex(index);
        return {
          success: true,
          status,
          module: status === "up_to_date" ? this.toDescriptor(previous) : descriptor,
          currentVersion: previous.version,
          currentRevision: previous.revision,
        };
      }

      await this.replaceDirectory(stagingDir, moduleDir);
      didMoveStaging = true;
      this.upsertIndex(index, descriptor);
      await this.writeIndex(index);

      return {
        success: true,
        status: this.installStatus(previous, descriptor),
        module: descriptor,
      };
    } finally {
      if (!didMoveStaging) {
        await fs.rm(stagingDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Install from a GitHub repository URL.
   *
   * @param source - GitHub source reference.
   * @returns Installation result.
   */
  private async installFromGithubSource(
    source: ModuleSourceReference
  ): Promise<ModuleInstallResult> {
    const index = await this.readIndex();
    const normalizedSource: ModuleSourceReference = {
      type: "github",
      location: source.location.trim(),
    };
    const stagingDir = await fs.mkdtemp(path.join(this.modulesRoot, "stage-git-"));
    let didMoveStaging = false;
    try {
      await this.runGit(["clone", "--depth", "1", normalizedSource.location, stagingDir]);
      const revision = await this.tryReadGitRevision(stagingDir);
      const manifest = await this.readAndValidateManifest(stagingDir);
      const moduleDir = path.join(this.packagesRoot, manifest.id);
      const previous = index.modules[manifest.id];

      await this.replaceDirectory(stagingDir, moduleDir);
      didMoveStaging = true;

      const descriptor: ModuleDescriptor = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        source: normalizedSource,
        revision,
        installPath: moduleDir,
      };
      if (previous) {
        const status = this.duplicateInstallStatus(previous, descriptor);
        this.recordUpdateCheck(index, descriptor, status);
        await this.writeIndex(index);
        return {
          success: true,
          status,
          module: status === "up_to_date" ? this.toDescriptor(previous) : descriptor,
          currentVersion: previous.version,
          currentRevision: previous.revision,
        };
      }
      this.upsertIndex(index, descriptor);
      await this.writeIndex(index);
      return {
        success: true,
        status: this.installStatus(previous, descriptor),
        module: descriptor,
      };
    } finally {
      if (!didMoveStaging) {
        await fs.rm(stagingDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Ensure module store directories exist.
   */
  private async ensureStoreDirs(): Promise<void> {
    await fs.mkdir(this.modulesRoot, { recursive: true });
    await fs.mkdir(this.packagesRoot, { recursive: true });
  }

  /**
   * Read and validate the on-disk module index, or return an empty default.
   *
   * @returns Parsed index object.
   */
  private async readIndex(): Promise<ModuleStoreIndex> {
    await this.ensureStoreDirs();
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return this.defaultIndex();
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Module index is not valid JSON: ${this.indexPath}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Module index has invalid shape: ${this.indexPath}`);
    }
    const obj = parsed as {
      schema_version?: unknown;
      modules?: unknown;
      history?: unknown;
    };
    const modulesRaw = obj.modules;
    const historyRaw = obj.history;
    if (!modulesRaw || typeof modulesRaw !== "object" || Array.isArray(modulesRaw)) {
      throw new Error(`Module index has invalid "modules" field: ${this.indexPath}`);
    }
    if (!Array.isArray(historyRaw)) {
      throw new Error(`Module index has invalid "history" field: ${this.indexPath}`);
    }
    return {
      schema_version:
        typeof obj.schema_version === "string"
          ? obj.schema_version
          : MODULE_INDEX_SCHEMA_VERSION,
      modules: modulesRaw as Record<string, StoredModuleRecord>,
      history: historyRaw as ModuleStoreIndex["history"],
    };
  }

  /**
   * Persist the module index to disk.
   *
   * @param index - Index payload to write.
   */
  private async writeIndex(index: ModuleStoreIndex): Promise<void> {
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  /**
   * Return the canonical empty index object.
   *
   * @returns Empty module index.
   */
  private defaultIndex(): ModuleStoreIndex {
    return {
      schema_version: MODULE_INDEX_SCHEMA_VERSION,
      modules: {},
      history: [],
    };
  }

  /**
   * Read and validate `pdv-module.json` from one directory.
   *
   * @param moduleDir - Directory expected to contain `pdv-module.json`.
   * @returns Validated manifest object.
   */
  private async readAndValidateManifest(moduleDir: string): Promise<ModuleManifestV1> {
    const manifestPath = path.join(moduleDir, MODULE_MANIFEST_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`Missing ${MODULE_MANIFEST_FILE} in ${moduleDir}`);
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in ${manifestPath}`);
    }
    return validateModuleManifest(parsed, manifestPath);
  }

  /**
   * Execute a git command.
   *
   * @param args - Git CLI arguments.
   * @param cwd - Optional working directory.
   * @returns Combined command output.
   * @throws {Error} When git exits non-zero.
   */
  private async runGit(
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, cwd ? { cwd } : undefined);
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    } catch (error) {
      const err = error as {
        stdout?: string | Uint8Array;
        stderr?: string | Uint8Array;
        message?: string;
      };
      const output = [err.stdout?.toString(), err.stderr?.toString(), err.message]
        .filter((value) => !!value)
        .join("\n");
      throw new Error(`git ${args.join(" ")} failed: ${output}`);
    }
  }

  /**
   * Read current Git HEAD revision from one module directory.
   *
   * @param moduleDir - Module directory path.
   * @returns SHA string when available, otherwise undefined.
   */
  private async tryReadGitRevision(moduleDir: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.runGit(["rev-parse", "HEAD"], moduleDir);
      const revision = stdout.trim();
      return revision.length > 0 ? revision : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Replace a destination directory with a source directory.
   *
   * @param sourceDir - Existing source directory to move/copy from.
   * @param destinationDir - Destination directory to replace.
   */
  private async replaceDirectory(
    sourceDir: string,
    destinationDir: string
  ): Promise<void> {
    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destinationDir), { recursive: true });
    try {
      await fs.rename(sourceDir, destinationDir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EXDEV") {
        throw error;
      }
      await fs.cp(sourceDir, destinationDir, { recursive: true, errorOnExist: false });
      await fs.rm(sourceDir, { recursive: true, force: true });
    }
  }

  /**
   * Insert or update one module record in the index.
   *
   * @param index - Mutable store index.
   * @param descriptor - Installed module descriptor.
   */
  private upsertIndex(
    index: ModuleStoreIndex,
    descriptor: ModuleDescriptor
  ): void {
    const now = new Date().toISOString();
    const existing = index.modules[descriptor.id];
    index.modules[descriptor.id] = {
      ...descriptor,
      installed_at: existing ? existing.installed_at : now,
      updated_at: now,
    };
    index.history.push({
      timestamp: now,
      module_id: descriptor.id,
      version: descriptor.version,
      revision: descriptor.revision,
      source: descriptor.source,
      action: existing ? "updated" : "installed",
    });
  }

  /**
   * Record one duplicate-install update-check event in history.
   *
   * @param index - Mutable store index.
   * @param descriptor - Candidate module descriptor from the attempted install.
   * @param outcome - Evaluated duplicate-install outcome.
   */
  private recordUpdateCheck(
    index: ModuleStoreIndex,
    descriptor: ModuleDescriptor,
    outcome: ModuleInstallResult["status"]
  ): void {
    index.history.push({
      timestamp: new Date().toISOString(),
      module_id: descriptor.id,
      version: descriptor.version,
      revision: descriptor.revision,
      source: descriptor.source,
      action: "update_check",
      outcome,
    });
  }

  /**
   * Convert stored metadata into public descriptor shape.
   *
   * @param record - Stored index record.
   * @returns Public descriptor.
   */
  private toDescriptor(record: StoredModuleRecord): ModuleDescriptor {
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      revision: record.revision,
      installPath: record.installPath,
    };
  }

  /**
   * Compute install status for an install operation.
   *
   * @param previous - Previously installed module record, when present.
   * @param next - Newly installed descriptor.
   * @returns Install status token.
   */
  private installStatus(
    previous: StoredModuleRecord | undefined,
    next: ModuleDescriptor
  ): ModuleInstallResult["status"] {
    if (
      previous &&
      previous.version === next.version &&
      previous.revision === next.revision
    ) {
      return "up_to_date";
    }
    return "installed";
  }

  /**
   * Evaluate duplicate install status without mutating installed module files.
   *
   * @param previous - Existing installed module record.
   * @param candidate - Candidate descriptor from the attempted install source.
   * @returns Duplicate install state.
   */
  private duplicateInstallStatus(
    previous: StoredModuleRecord,
    candidate: ModuleDescriptor
  ): ModuleInstallResult["status"] {
    if (
      previous.version === candidate.version &&
      previous.revision === candidate.revision
    ) {
      return "up_to_date";
    }
    const previousSemver = parseSemver(previous.version);
    const candidateSemver = parseSemver(candidate.version);
    if (
      previousSemver &&
      candidateSemver &&
      previousSemver.major !== candidateSemver.major
    ) {
      return "incompatible_update";
    }
    return "update_available";
  }
}

/**
 * Validate one parsed `pdv-module.json` payload.
 *
 * @param value - Parsed JSON value.
 * @param manifestPath - Manifest path used in error messages.
 * @returns Strongly typed validated manifest.
 * @throws {Error} When required fields are missing or invalid.
 */
function validateModuleManifest(
  value: unknown,
  manifestPath: string
): ModuleManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid module manifest object: ${manifestPath}`);
  }
  const obj = value as Record<string, unknown>;
  const schemaVersion = requiredString(obj, "schema_version", manifestPath);
  const id = requiredString(obj, "id", manifestPath);
  const name = requiredString(obj, "name", manifestPath);
  const version = requiredString(obj, "version", manifestPath);
  const description = optionalString(obj, "description", manifestPath);
  const compatibility = optionalCompatibility(obj, manifestPath);
  const dependencies = optionalDependencies(obj, manifestPath);
  const actionsRaw = obj.actions;
  if (!Array.isArray(actionsRaw)) {
    throw new Error(`"actions" must be an array in ${manifestPath}`);
  }
  const actions = actionsRaw.map((actionValue, index) => {
    if (!actionValue || typeof actionValue !== "object" || Array.isArray(actionValue)) {
      throw new Error(`actions[${index}] must be an object in ${manifestPath}`);
    }
    const actionObj = actionValue as Record<string, unknown>;
    return {
      id: requiredString(actionObj, "id", manifestPath, `actions[${index}]`),
      label: requiredString(actionObj, "label", manifestPath, `actions[${index}]`),
      script_path: requiredString(
        actionObj,
        "script_path",
        manifestPath,
        `actions[${index}]`
      ),
    };
  });
  return {
    schema_version: schemaVersion,
    id,
    name,
    version,
    description,
    compatibility,
    dependencies,
    actions,
  };
}

/**
 * Read one required string field from an object.
 *
 * @param obj - Source object.
 * @param key - Required field key.
 * @param filePath - File path for diagnostics.
 * @param prefix - Optional parent field prefix.
 * @returns Non-empty string value.
 * @throws {Error} When value is absent or invalid.
 */
function requiredString(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string
): string {
  const raw = obj[key];
  const display = prefix ? `${prefix}.${key}` : key;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`"${display}" must be a non-empty string in ${filePath}`);
  }
  return raw.trim();
}

/**
 * Read one optional string field from an object.
 *
 * @param obj - Source object.
 * @param key - Optional field key.
 * @param filePath - File path for diagnostics.
 * @returns String value when present, otherwise undefined.
 * @throws {Error} When present but invalid.
 */
function optionalString(
  obj: Record<string, unknown>,
  key: string,
  filePath: string
): string | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`"${key}" must be a string in ${filePath}`);
  }
  return raw;
}

/**
 * Parse optional `compatibility` object from a module manifest.
 *
 * @param obj - Source manifest object.
 * @param filePath - Manifest path for diagnostics.
 * @returns Parsed compatibility object or undefined.
 */
function optionalCompatibility(
  obj: Record<string, unknown>,
  filePath: string
):
  | {
      pdv_min?: string;
      pdv_max?: string;
      python?: string;
      python_min?: string;
      python_max?: string;
    }
  | undefined {
  const raw = obj.compatibility;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"compatibility" must be an object in ${filePath}`);
  }
  const compat = raw as Record<string, unknown>;
  return {
    pdv_min: optionalString(compat, "pdv_min", filePath),
    pdv_max: optionalString(compat, "pdv_max", filePath),
    python: optionalString(compat, "python", filePath),
    python_min: optionalString(compat, "python_min", filePath),
    python_max: optionalString(compat, "python_max", filePath),
  };
}

/**
 * Parse optional `dependencies` list from a module manifest.
 *
 * @param obj - Source manifest object.
 * @param filePath - Manifest path for diagnostics.
 * @returns Parsed dependency list or undefined.
 */
function optionalDependencies(
  obj: Record<string, unknown>,
  filePath: string
): Array<{ name: string; version?: string; marker?: string }> | undefined {
  const raw = obj.dependencies;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`"dependencies" must be an array in ${filePath}`);
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`dependencies[${index}] must be an object in ${filePath}`);
    }
    const dep = entry as Record<string, unknown>;
    return {
      name: requiredString(dep, "name", filePath, `dependencies[${index}]`),
      version: optionalString(dep, "version", filePath),
      marker: optionalString(dep, "marker", filePath),
    };
  });
}

/**
 * Parse a semantic version string into numeric components.
 *
 * Accepts `major.minor.patch` with optional pre-release/build metadata suffixes.
 *
 * @param version - Version string to parse.
 * @returns Parsed numeric parts, or null when parsing fails.
 */
function parseSemver(
  version: string
): { major: number; minor: number; patch: number } | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Compare two semantic versions.
 *
 * @param left - Left-side semantic version.
 * @param right - Right-side semantic version.
 * @returns Negative when left < right, 0 when equal, positive when left > right.
 */
function compareSemver(left: string, right: string): number | null {
  const l = parseLooseSemver(left);
  const r = parseLooseSemver(right);
  if (!l || !r) return null;
  if (l.major !== r.major) return l.major - r.major;
  if (l.minor !== r.minor) return l.minor - r.minor;
  return l.patch - r.patch;
}

/**
 * Parse a semantic version in `x.y` or `x.y.z` form.
 *
 * @param version - Version string candidate.
 * @returns Parsed numeric version or null.
 */
function parseLooseSemver(
  version: string
): { major: number; minor: number; patch: number } | null {
  const strict = parseSemver(version);
  if (strict) return strict;
  const match = version.trim().match(/^(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return null;
  }
  return { major, minor, patch: 0 };
}

/**
 * Return true when one version is semantically lower than another.
 *
 * Unparseable versions are treated as non-comparable and return false.
 */
function isVersionLessThan(left: string, right: string): boolean {
  const compared = compareSemver(left, right);
  return compared !== null && compared < 0;
}

/**
 * Return true when one version is semantically greater than another.
 *
 * Unparseable versions are treated as non-comparable and return false.
 */
function isVersionGreaterThan(left: string, right: string): boolean {
  const compared = compareSemver(left, right);
  return compared !== null && compared > 0;
}

/**
 * Validate a current Python version against compatibility constraints.
 *
 * Supports simple comparator expressions such as `>=3.10,<3.13`.
 *
 * @param currentVersion - Current Python version string.
 * @param compatibility - Manifest compatibility object.
 * @returns True when all parseable constraints are satisfied.
 */
function isPythonVersionCompatible(
  currentVersion: string,
  compatibility: {
    python?: string;
    python_min?: string;
    python_max?: string;
  }
): boolean {
  const normalized = extractVersionToken(currentVersion);
  if (!normalized) return false;
  if (compatibility.python) {
    const constraints = compatibility.python
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (const constraint of constraints) {
      if (!evaluateSimpleConstraint(normalized, constraint)) {
        return false;
      }
    }
  }
  if (compatibility.python_min && isVersionLessThan(normalized, compatibility.python_min)) {
    return false;
  }
  if (compatibility.python_max && isVersionGreaterThan(normalized, compatibility.python_max)) {
    return false;
  }
  return true;
}

/**
 * Extract a comparable version token from a raw version string.
 *
 * @param value - Raw version text (e.g. `Python 3.11.7`).
 * @returns Comparable token (e.g. `3.11.7`) or null.
 */
function extractVersionToken(value: string): string | null {
  const trimmed = value.trim();
  const direct = parseLooseSemver(trimmed);
  if (direct) return `${direct.major}.${direct.minor}.${direct.patch}`;
  const match = trimmed.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = parseLooseSemver(match[1]);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Evaluate a simple comparator expression against a version token.
 *
 * @param current - Comparable current version token.
 * @param constraint - One constraint, e.g. `>=3.10`.
 * @returns True when satisfied or not parseable.
 */
function evaluateSimpleConstraint(current: string, constraint: string): boolean {
  const match = constraint.match(/^(<=|>=|<|>|=)?\s*(\d+\.\d+(?:\.\d+)?)$/);
  if (!match) {
    return true;
  }
  const operator = match[1] ?? "=";
  const target = match[2];
  const compared = compareSemver(current, target);
  if (compared === null) return true;
  if (operator === "<") return compared < 0;
  if (operator === "<=") return compared <= 0;
  if (operator === ">") return compared > 0;
  if (operator === ">=") return compared >= 0;
  return compared === 0;
}

/**
 * Normalize a script node name derived from manifest script paths.
 *
 * @param value - Raw filename/action identifier.
 * @returns Safe non-empty tree node name.
 */
function sanitizeScriptNodeName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_]/g, "_");
  return normalized.length > 0 ? normalized : "script";
}
