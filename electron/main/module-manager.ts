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
  ModuleInputValue,
  ModuleSourceReference,
  ModuleUninstallResult,
  ModuleUpdateResult,
} from "./ipc";
import type { ModuleGuiLayout } from "./ipc";
import {
  deriveHasGui,
  isV3Manifest,
  isV4Manifest,
  isPythonVersionCompatible,
  isVersionGreaterThan,
  isVersionLessThan,
  ModuleManifestV1,
  GuiManifestV1,
  parseSemver,
  readGuiManifest,
  sanitizeScriptNodeName,
  validateModuleManifest,
} from "./modules/manifest-utils";
import type { NodeDescriptor } from "./pdv-protocol";

const execFileAsync = promisify(execFile);

/** Current on-disk metadata index schema version. */
const MODULE_INDEX_SCHEMA_VERSION = "1.0";

/** Name of the required module manifest file. */
const MODULE_MANIFEST_FILE = "pdv-module.json";

/**
 * Declarative input field descriptor from a module manifest.
 */
interface ModuleInputDescriptor {
  /** Stable input identifier from manifest. */
  id: string;
  /** User-facing label. */
  label: string;
  /** Optional data type hint (e.g. "int", "float", "str"). */
  type?: string;
  /** UI control type rendered by the modules panel. */
  control?: "text" | "dropdown" | "slider" | "checkbox" | "file";
  /** Optional default value/state. */
  default?: ModuleInputValue;
  /** Optional dropdown options for `control: "dropdown"`. */
  options?: Array<{ label: string; value: ModuleInputValue }>;
  /** Optional tree path used to populate dropdown options from child keys. */
  optionsTreePath?: string;
  /** Optional slider metadata. */
  min?: number;
  max?: number;
  step?: number;
  /** Grouping metadata for module-internal tab/section layout. */
  tab?: string;
  section?: string;
  sectionCollapsed?: boolean;
  /** Optional hover tooltip. */
  tooltip?: string;
  /** Optional conditional visibility rule. */
  visibleIf?: {
    inputId: string;
    equals: ModuleInputValue;
  };
  /** Optional file picker mode for `control: "file"`. */
  fileMode?: "file" | "directory";
}

/**
 * One canonical script binding derived from a module action descriptor.
 */
interface ModuleScriptBinding {
  /** Stable action identifier from manifest. */
  actionId: string;
  /** User-facing action label from manifest. */
  actionLabel: string;
  /** Script node name under `<alias>.scripts.<name>`. */
  name: string;
  /** Absolute path to the backing Python script file. */
  scriptPath: string;
  /** Input IDs this action references (passed as kwargs on run). */
  inputIds?: string[];
  /** Optional module-internal tab where this action should appear. */
  actionTab?: string;
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
  /** Lazily resolved bundled modules directory. `undefined` = not yet resolved. */
  private _bundledModulesDir: string | null | undefined = undefined;

  /**
   * @param pdvDir - PDV application data root (e.g. `~/.PDV`).
   */
  constructor(private readonly pdvDir: string) {
    this.modulesRoot = path.join(this.pdvDir, "modules");
    this.packagesRoot = path.join(this.modulesRoot, "packages");
    this.indexPath = path.join(this.modulesRoot, "index.json");
  }

  /** Lazily resolve and cache the bundled modules directory. */
  private get bundledModulesDir(): string | null {
    if (this._bundledModulesDir === undefined) {
      this._bundledModulesDir = ModuleManager.resolveBundledModulesDir();
    }
    return this._bundledModulesDir;
  }

  /**
   * Locate the bundled example modules directory.
   *
   * In packaged builds the examples are in ``process.resourcesPath``.
   * In development ``__dirname`` is ``electron/dist/main``; walk upward to
   * find the repo-root ``examples/modules/`` directory.
   *
   * @returns Absolute path, or null when not found.
   */
  private static resolveBundledModulesDir(): string | null {
    if (process.resourcesPath) {
      const candidate = path.join(process.resourcesPath, "examples", "modules");
      try {
        const stat = require("fs").statSync(candidate);
        if (stat.isDirectory()) return candidate;
      } catch { /* fall through */ }
    }
    for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const candidate = path.join(dir, "examples", "modules");
      try {
        const stat = require("fs").statSync(candidate);
        if (stat.isDirectory()) return candidate;
      } catch { /* continue */ }
    }
    return null;
  }

  /**
   * List bundled example modules from the app resources directory.
   *
   * @returns Bundled module descriptors (read-only, not in global store).
   */
  private async listBundledModules(): Promise<ModuleDescriptor[]> {
    if (!this.bundledModulesDir) return [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.bundledModulesDir);
    } catch {
      return [];
    }
    const descriptors: ModuleDescriptor[] = [];
    for (const entry of entries) {
      const entryDir = path.join(this.bundledModulesDir, entry);
      try {
        const stat = await fs.stat(entryDir);
        if (!stat.isDirectory()) continue;
        const manifest = await this.readAndValidateManifest(entryDir);
        descriptors.push({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          language: manifest.language,
          source: { type: "bundled", location: entryDir },
          installPath: entryDir,
          upstream: manifest.upstream,
        });
      } catch {
        // Skip invalid bundled modules silently.
      }
    }
    return descriptors;
  }

  /**
   * Resolve a module record by id, checking the store index first then
   * falling back to bundled example modules.
   *
   * @param moduleId - Module identifier.
   * @returns Stored record (or a synthetic one for bundled modules), or null.
   */
  private async resolveModuleRecord(
    moduleId: string,
    projectDir?: string | null,
  ): Promise<StoredModuleRecord | null> {
    // Check project-local modules directory first.
    if (projectDir) {
      const localPath = path.join(projectDir, "modules", moduleId);
      try {
        const stat = await fs.stat(localPath);
        if (stat.isDirectory()) {
          const manifest = await this.readAndValidateManifest(localPath);
          const now = new Date().toISOString();
          return {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            language: manifest.language,
            source: { type: "local", location: localPath },
            installPath: localPath,
            upstream: manifest.upstream,
            installed_at: now,
            updated_at: now,
          };
        }
      } catch { /* fall through */ }
    }

    const index = await this.readIndex();
    const record = index.modules[moduleId];
    if (record) return record;

    // Fall back to bundled modules.
    const bundled = await this.listBundledModules();
    const match = bundled.find((m) => m.id === moduleId);
    if (!match) return null;
    const now = new Date().toISOString();
    return {
      ...match,
      installed_at: now,
      updated_at: now,
    };
  }

  /**
   * Resolve the on-disk directory for a module, checking a project-local
   * ``modules/`` directory first, then the global store and bundled modules.
   *
   * @param moduleId - Module identifier.
   * @param projectDir - Active project directory (optional).
   * @returns Absolute directory path, or null when not found.
   */
  async resolveModuleDir(
    moduleId: string,
    projectDir?: string | null,
  ): Promise<string | null> {
    if (projectDir) {
      const localPath = path.join(projectDir, "modules", moduleId);
      try {
        const stat = await fs.stat(localPath);
        if (stat.isDirectory()) return localPath;
      } catch { /* fall through */ }
    }
    const record = await this.resolveModuleRecord(moduleId, projectDir);
    if (!record) return null;
    return record.installPath ?? path.join(this.packagesRoot, moduleId);
  }

  /**
   * List installed modules from the persisted metadata index,
   * merged with bundled example modules.
   *
   * User-installed modules with the same ID take precedence over bundled.
   *
   * @returns Module descriptors sorted by name then id.
   * @throws {Error} When the metadata index exists but is invalid.
   */
  async listInstalled(): Promise<ModuleDescriptor[]> {
    const index = await this.readIndex();
    const indexIds = new Set(Object.keys(index.modules));
    const descriptors = Object.values(index.modules).map((record) =>
      this.toDescriptor(record)
    );

    // Merge bundled modules that are not overridden by user-installed ones.
    const bundled = await this.listBundledModules();
    for (const bm of bundled) {
      if (!indexIds.has(bm.id)) {
        descriptors.push(bm);
      }
    }

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
   * Uninstall a module from the global store.
   *
   * Removes the module directory and its metadata from the index.
   * Bundled modules cannot be uninstalled.
   *
   * @param moduleId - Module identifier to uninstall.
   * @returns Uninstall result payload.
   */
  async uninstall(moduleId: string): Promise<ModuleUninstallResult> {
    const index = await this.readIndex();
    const module = index.modules[moduleId];
    if (!module) {
      return { success: false, error: `Module not installed: ${moduleId}` };
    }
    if (module.source.type === "bundled") {
      return { success: false, error: "Cannot uninstall bundled modules" };
    }
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    await fs.rm(moduleDir, { recursive: true, force: true });
    delete index.modules[moduleId];
    await this.writeIndex(index);
    return { success: true };
  }

  /**
   * Check if an update is available for one installed module.
   *
   * Uses ``git ls-remote --tags`` against the module's ``upstream`` URL to
   * discover the latest release tag without cloning the repository.
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
    const upstream = entry.upstream;
    if (!upstream) {
      return {
        moduleId,
        status: "not_implemented",
        currentVersion: entry.version,
        message: "No upstream URL configured for this module.",
      };
    }
    try {
      const { stdout } = await this.runGit(["ls-remote", "--tags", upstream]);
      const latestTag = this.parseLatestTagFromLsRemote(stdout);
      if (!latestTag) {
        return {
          moduleId,
          status: "up_to_date",
          currentVersion: entry.version,
          message: "No release tags found in upstream repository.",
        };
      }
      if (!isVersionGreaterThan(latestTag, entry.version)) {
        return {
          moduleId,
          status: "up_to_date",
          currentVersion: entry.version,
        };
      }
      return {
        moduleId,
        status: "update_available",
        currentVersion: entry.version,
        availableVersion: latestTag,
      };
    } catch (error) {
      return {
        moduleId,
        status: "unknown",
        currentVersion: entry.version,
        message: `Failed to check upstream: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Update an installed module from its upstream source.
   *
   * Re-clones from the ``upstream`` URL and replaces the module in the
   * global store. Projects must re-import to pick up changes.
   *
   * @param moduleId - Module identifier to update.
   * @returns Install result reflecting the update outcome.
   */
  async update(moduleId: string): Promise<ModuleInstallResult> {
    const index = await this.readIndex();
    const entry = index.modules[moduleId];
    if (!entry?.upstream) {
      return { success: false, status: "error", error: "No upstream URL configured" };
    }
    const upstream = entry.upstream;
    // Clone to a staging directory, validate, then atomically replace.
    // The old module directory and index entry remain untouched until
    // the new version is fully staged and validated.
    await this.ensureStoreDirs();
    const stagingDir = path.join(
      this.packagesRoot,
      `stage-update-${moduleId}-${Date.now()}`
    );
    try {
      await this.runGit(["clone", "--depth", "1", upstream, stagingDir]);
      const manifest = await this.readAndValidateManifest(stagingDir);
      const moduleDir = path.join(this.packagesRoot, manifest.id);
      await this.replaceDirectory(stagingDir, moduleDir);

      // Update the index with the new version.
      const freshIndex = await this.readIndex();
      const { stdout: revStdout } = await this.runGit(
        ["-C", moduleDir, "rev-parse", "--short", "HEAD"]
      ).catch(() => ({ stdout: "" }));
      const revision = revStdout.trim() || undefined;
      freshIndex.modules[manifest.id] = {
        ...freshIndex.modules[manifest.id],
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        language: manifest.language,
        source: { type: "github", location: upstream },
        revision,
        installPath: moduleDir,
        upstream,
        updated_at: new Date().toISOString(),
      };
      await this.writeIndex(freshIndex);
      return {
        success: true,
        status: "installed",
        module: this.toDescriptor(freshIndex.modules[manifest.id]!),
      };
    } catch (error) {
      // Clean up staging directory on failure; original module is untouched.
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return {
        success: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Resolve canonical script bindings for one installed module.
   *
   * @param moduleId - Installed module identifier.
   * @returns Canonical script bindings derived from manifest actions.
   * @throws {Error} When the module or any referenced script path is invalid.
   */
  async resolveActionScripts(moduleId: string, projectDir?: string | null): Promise<ModuleScriptBinding[]> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) {
      throw new Error(`Installed module not found: ${moduleId}`);
    }
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    const manifest = await this.readAndValidateManifest(moduleDir);

    const actions = await this.resolveActions(manifest, moduleDir);
    const usedNames = new Set<string>();
    const bindings: ModuleScriptBinding[] = [];
    for (const action of actions) {
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
        inputIds: action.inputs,
        ...(action.tab ? { actionTab: action.tab } : {}),
      });
    }
    return bindings;
  }

  /**
   * Return the declarative input descriptors for one installed module.
   *
   * @param moduleId - Installed module identifier.
   * @returns Input descriptors from the manifest, or empty array.
   */
  async getModuleInputs(moduleId: string, projectDir?: string | null): Promise<ModuleInputDescriptor[]> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) {
      return [];
    }
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    const manifest = await this.readAndValidateManifest(moduleDir);
    const inputs = await this.resolveInputs(manifest, moduleDir);
    return inputs.map((input) => ({
      id: input.id,
      label: input.label,
      type: input.type,
      control: input.control,
      default: input.default,
      options: input.options,
      optionsTreePath: input.options_tree_path,
      min: input.min,
      max: input.max,
      step: input.step,
      tab: input.tab,
      section: input.section,
      sectionCollapsed: input.section_collapsed,
      tooltip: input.tooltip,
      visibleIf: input.visible_if
        ? {
            inputId: input.visible_if.input_id,
            equals: input.visible_if.equals,
          }
        : undefined,
      fileMode: input.file_mode,
    }));
  }

  /**
   * Return the `hasGui` flag and optional `gui` layout for one installed module.
   *
   * @param moduleId - Installed module identifier.
   * @returns Object with `hasGui` boolean and optional `gui` layout.
   */
  async getModuleGuiInfo(
    moduleId: string,
    projectDir?: string | null,
  ): Promise<{ hasGui: boolean; gui?: ModuleGuiLayout }> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) {
      return { hasGui: false };
    }
    const moduleDir =
      module.installPath ?? path.join(this.packagesRoot, moduleId);
    const manifest = await this.readAndValidateManifest(moduleDir);
    if (isV4Manifest(manifest)) {
      if (!manifest.default_gui) return { hasGui: false };
      const guiManifest = await readGuiManifest(moduleDir);
      if (!guiManifest) return { hasGui: false };
      const hasGui = guiManifest.has_gui ?? ((guiManifest.inputs?.length ?? 0) > 0 || guiManifest.actions.length > 0);
      const gui = guiManifest.gui ? (guiManifest.gui as ModuleGuiLayout) : undefined;
      return { hasGui, gui };
    }
    if (isV3Manifest(manifest)) {
      const guiManifest = await readGuiManifest(moduleDir);
      if (!guiManifest) return { hasGui: false };
      const hasGui = guiManifest.has_gui ?? ((guiManifest.inputs?.length ?? 0) > 0 || guiManifest.actions.length > 0);
      const gui = guiManifest.gui ? (guiManifest.gui as ModuleGuiLayout) : undefined;
      return { hasGui, gui };
    }
    const hasGui = deriveHasGui(manifest);
    const gui = manifest.gui
      ? (manifest.gui as ModuleGuiLayout)
      : undefined;
    return { hasGui, gui };
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
    context: { pdvVersion: string; pythonVersion?: string },
    projectDir?: string | null,
  ): Promise<ModuleHealthWarning[]> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
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

    if (isV4Manifest(manifest)) {
      // v4: check all local_file backend paths in module-index.json
      const moduleIndex = await this.readModuleIndex(moduleDir);
      for (const node of moduleIndex) {
        const storage = (node as unknown as Record<string, unknown>).storage as Record<string, unknown> | undefined;
        if (storage?.backend !== "local_file") continue;
        const relPath = typeof storage?.relative_path === "string" ? storage.relative_path : "";
        if (!relPath) continue;
        const absPath = path.resolve(moduleDir, relPath);
        try {
          const stat = await fs.stat(absPath);
          if (!stat.isFile()) {
            warnings.push({
              code: "missing_action_script",
              message: `Module file is not a file: ${relPath}`,
            });
          }
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === "ENOENT") {
            warnings.push({
              code: "missing_action_script",
              message: `Module file not found: ${relPath}`,
            });
            continue;
          }
          throw error;
        }
      }
      return warnings;
    }

    const healthActions = await this.resolveActions(manifest, moduleDir);
    for (const action of healthActions) {
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
   * Read and validate gui.json for one installed module.
   *
   * @param moduleId - Installed module identifier.
   * @returns Validated GUI manifest, or null if absent.
   */
  async readAndValidateGuiManifest(moduleId: string): Promise<GuiManifestV1 | null> {
    const module = await this.resolveModuleRecord(moduleId);
    if (!module) return null;
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    return readGuiManifest(moduleDir);
  }

  /**
   * Return the install path for one installed module.
   *
   * @param moduleId - Installed module identifier.
   * @returns Absolute install path, or null if not installed.
   */
  async getModuleInstallPath(moduleId: string, projectDir?: string | null): Promise<string | null> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) return null;
    return module.installPath ?? path.join(this.packagesRoot, moduleId);
  }

  /**
   * Return the declared dependencies for one module from its manifest.
   *
   * @param moduleId - Module identifier.
   * @param projectDir - Optional project directory for local resolution.
   * @returns Dependency array from the manifest, or empty array.
   */
  async getModuleDependencies(
    moduleId: string,
    projectDir?: string | null,
  ): Promise<Array<{ name: string; version?: string; marker?: string }>> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) return [];
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    try {
      const manifest = await this.readAndValidateManifest(moduleDir);
      return manifest.dependencies ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Return true when an installed module uses the v4 module-index.json format.
   *
   * @param moduleId - Installed module identifier.
   * @returns True when the module manifest has schema_version "4".
   */
  async isV4Module(moduleId: string, projectDir?: string | null): Promise<boolean> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) return false;
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    try {
      const manifest = await this.readAndValidateManifest(moduleDir);
      return isV4Manifest(manifest);
    } catch {
      return false;
    }
  }

  /**
   * Read and parse `module-index.json` from an installed module directory.
   *
   * @param moduleDir - Absolute path to the module directory.
   * @returns Array of node descriptors, or empty array when the file is absent.
   * @throws {Error} When the file exists but contains invalid JSON.
   */
  async readModuleIndex(moduleDir: string): Promise<NodeDescriptor[]> {
    const indexPath = path.join(moduleDir, "module-index.json");
    let raw: string;
    try {
      raw = await fs.readFile(indexPath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in ${indexPath}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`module-index.json must be an array in ${indexPath}`);
    }
    return parsed as NodeDescriptor[];
  }

  /**
   * Resolve declared module files from the manifest `files` array.
   *
   * @param moduleId - Installed module identifier.
   * @returns Resolved file descriptors with absolute paths.
   * @throws {Error} When module is not installed or a file doesn't exist.
   */
  async resolveModuleFiles(
    moduleId: string,
    projectDir?: string | null,
  ): Promise<Array<{ name: string; path: string; type: "namelist" | "lib" | "file" }>> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) {
      return [];
    }
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    const manifest = await this.readAndValidateManifest(moduleDir);
    if (!manifest.files || manifest.files.length === 0) {
      return [];
    }
    const resolved: Array<{ name: string; path: string; type: "namelist" | "lib" | "file" }> = [];
    for (const file of manifest.files) {
      const absPath = path.resolve(moduleDir, file.path);
      try {
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) {
          console.warn(`[pdv] Module file is not a file: ${file.path} (${moduleId})`);
          continue;
        }
      } catch {
        console.warn(`[pdv] Module file not found: ${file.path} (${moduleId})`);
        continue;
      }
      resolved.push({
        name: file.name,
        path: absPath,
        type: file.type,
      });
    }
    return resolved;
  }

  /**
   * Return module setup info for library namespace initialization.
   *
   * @param moduleId - Installed module identifier.
   * @returns Install path and optional python_package/entry_point from manifest.
   * @throws {Error} When module is not installed or manifest is invalid.
   */
  async getModuleSetupInfo(moduleId: string, projectDir?: string | null): Promise<{
    installPath: string;
    pythonPackage?: string;
    entryPoint?: string;
    libDir?: string;
  }> {
    const module = await this.resolveModuleRecord(moduleId, projectDir);
    if (!module) {
      throw new Error(`Installed module not found: ${moduleId}`);
    }
    const moduleDir = module.installPath ?? path.join(this.packagesRoot, moduleId);
    const manifest = await this.readAndValidateManifest(moduleDir);
    return {
      installPath: moduleDir,
      pythonPackage: manifest.python_package,
      entryPoint: manifest.entry_point,
      libDir: manifest.lib_dir,
    };
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
        language: manifest.language,
        source: normalizedSource,
        installPath: moduleDir,
        upstream: manifest.upstream,
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
        language: manifest.language,
        source: normalizedSource,
        revision,
        installPath: moduleDir,
        upstream: manifest.upstream ?? normalizedSource.location,
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
   * Resolve the effective actions list for a module, reading from gui.json for v3.
   *
   * @param manifest - Validated module manifest.
   * @param moduleDir - Module directory path.
   * @returns Action entries from the appropriate source.
   */
  private async resolveActions(
    manifest: ModuleManifestV1,
    moduleDir: string
  ): Promise<Array<{ id: string; label: string; script_path: string; inputs?: string[]; tab?: string }>> {
    if (isV3Manifest(manifest) || isV4Manifest(manifest)) {
      const guiManifest = await readGuiManifest(moduleDir);
      return guiManifest?.actions ?? [];
    }
    return manifest.actions ?? [];
  }

  /**
   * Resolve the effective inputs list for a module, reading from gui.json for v3/v4.
   *
   * @param manifest - Validated module manifest.
   * @param moduleDir - Module directory path.
   * @returns Input entries from the appropriate source.
   */
  private async resolveInputs(
    manifest: ModuleManifestV1,
    moduleDir: string
  ): Promise<NonNullable<ModuleManifestV1["inputs"]>> {
    if (isV3Manifest(manifest) || isV4Manifest(manifest)) {
      const guiManifest = await readGuiManifest(moduleDir);
      return guiManifest?.inputs ?? [];
    }
    return manifest.inputs ?? [];
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
      language: record.language,
      source: record.source,
      revision: record.revision,
      installPath: record.installPath,
      upstream: record.upstream,
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

  /**
   * Parse ``git ls-remote --tags`` output and return the latest semver tag.
   *
   * @param stdout - Raw stdout from git ls-remote.
   * @returns Latest semver version string (without leading ``v``), or null.
   */
  private parseLatestTagFromLsRemote(stdout: string): string | null {
    let latest: string | null = null;
    for (const line of stdout.split("\n")) {
      // Each line: "<sha>\trefs/tags/<tagname>"
      const match = line.match(/refs\/tags\/v?(\d+\.\d+\.\d+.*)$/);
      if (!match) continue;
      let tag = match[1];
      // Skip dereferenced tag objects (^{})
      if (tag.endsWith("^{}")) {
        tag = tag.slice(0, -3);
      }
      const semver = parseSemver(tag);
      if (!semver) continue;
      if (latest === null || isVersionGreaterThan(tag, latest)) {
        latest = tag;
      }
    }
    return latest;
  }
}
