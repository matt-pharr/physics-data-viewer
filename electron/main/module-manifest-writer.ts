/**
 * module-manifest-writer.ts — Write ``pdv-module.json`` and
 * ``module-index.json`` into a project-local module directory.
 *
 * Responsibilities:
 * - Produce a v4-shaped ``pdv-module.json`` from in-memory module metadata.
 * - Persist a ``module-index.json`` node descriptor list alongside it.
 *
 * Non-responsibilities:
 * - Collecting the descriptors (kernel-side in
 *   ``pdv.handlers.project._collect_module_manifests``).
 * - Copying file contents into ``<moduleDir>/`` (``ipc-register-project.ts``
 *   handles that via the §3 save-time sync step).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §5.13 (module storage and resolution),
 * ~/.claude/plans/parsed-mapping-creek.md §7.
 */

import * as fs from "fs/promises";
import * as path from "path";

/**
 * Subset of ``pdv-module.json`` fields that ``writeModuleManifest`` emits.
 * Mirrors the v4 schema documented in ARCHITECTURE.md §5.13 — optional
 * fields are omitted from the output when undefined so the resulting
 * JSON stays minimal and diff-friendly.
 */
export interface ModuleManifestInput {
  /** Unique module identifier (directory name under ``<saveDir>/modules/``). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Optional longer description surfaced in the modules list UI. */
  description?: string;
  /** Kernel language (defaults to ``"python"`` when omitted). */
  language?: "python" | "julia";
  /** Optional entry-point Python module name (e.g. ``"n_pendulum"``). */
  entryPoint?: string;
  /** Optional relative path to the lib directory (defaults to ``"lib"``). */
  libDir?: string;
  /** Optional relative path to the default GUI file. */
  defaultGui?: string;
  /** Optional dependency list (raw dicts passed through to JSON). */
  dependencies?: Array<Record<string, unknown>>;
}

/**
 * A single ``module-index.json`` entry. The kernel side builds these
 * via ``_collect_module_manifests`` in ``handlers/project.py`` — we
 * just typecheck that they're plain JSON-able dicts on the way out.
 */
export type ModuleIndexEntry = Record<string, unknown>;

/**
 * Write a v4 ``pdv-module.json`` into ``moduleDir``.
 *
 * Creates the destination directory on demand. Optional fields of
 * {@link ModuleManifestInput} are dropped from the output when unset.
 *
 * @param moduleDir - Absolute path to ``<saveDir>/modules/<id>/``.
 * @param input - Module metadata collected from the kernel.
 * @returns Nothing.
 * @throws {Error} When ``moduleDir`` cannot be created or the manifest
 *   cannot be written.
 */
export async function writeModuleManifest(
  moduleDir: string,
  input: ModuleManifestInput,
): Promise<void> {
  await fs.mkdir(moduleDir, { recursive: true });
  const manifest: Record<string, unknown> = {
    schema_version: "4",
    id: input.id,
    name: input.name,
    version: input.version,
    language: input.language ?? "python",
  };
  if (input.description) manifest.description = input.description;
  if (input.entryPoint) manifest.entry_point = input.entryPoint;
  if (input.libDir) manifest.lib_dir = input.libDir;
  if (input.defaultGui) manifest.default_gui = input.defaultGui;
  if (input.dependencies && input.dependencies.length > 0) {
    manifest.dependencies = input.dependencies;
  }
  const target = path.join(moduleDir, "pdv-module.json");
  await fs.writeFile(target, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/**
 * Write a v4 ``module-index.json`` into ``moduleDir``.
 *
 * The descriptor list is written as-is after normalizing the wrapping
 * JSON structure — the kernel-side collector is authoritative on the
 * shape of each entry, and this writer is intentionally dumb.
 *
 * @param moduleDir - Absolute path to ``<saveDir>/modules/<id>/``.
 * @param entries - Node descriptors rooted at the module.
 * @returns Nothing.
 * @throws {Error} When the index file cannot be written.
 */
export async function writeModuleIndex(
  moduleDir: string,
  entries: ModuleIndexEntry[],
): Promise<void> {
  await fs.mkdir(moduleDir, { recursive: true });
  const target = path.join(moduleDir, "module-index.json");
  await fs.writeFile(target, JSON.stringify(entries, null, 2) + "\n", "utf8");
}
