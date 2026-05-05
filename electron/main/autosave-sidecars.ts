/**
 * autosave-sidecars.ts — Helpers that write `.autosave/` companion files
 * (project.json, modules/, module-owned file mirrors) alongside the kernel-
 * produced tree-index.json + tree/ contents.
 *
 * Extracted from `electron/main/index.ts` so the autosave IPC handler stays
 * short and the manifest-synthesis logic can be unit-tested directly.
 *
 * See ARCHITECTURE.md §8.4 for the recovery flow these files participate in.
 */

import * as path from "path";
import {
  syncModuleOwnedFilesToSaveDir,
  writeModuleManifestsToSaveDir,
} from "./ipc-register-project";
import {
  ProjectManager,
  type ProjectManifest,
  type ProjectModuleImport,
  type ModuleManifestBundle,
  type ModuleOwnedFile,
} from "./project-manager";
import type { ModuleManager } from "./module-manager";

/** Outcome of a kernel-side autosave that this helper needs. */
export interface AutosaveResult {
  checksum: string;
  moduleOwnedFiles: ModuleOwnedFile[];
  moduleManifests: ModuleManifestBundle[];
}

/** State the manifest-synthesis path needs from the main process. */
export interface AutosaveManifestSource {
  /** Active project save dir, or `null` for an unsaved session. */
  activeProjectDir: string | null;
  /**
   * In-memory module imports that haven't been persisted to a project.json
   * yet. Synthesized into the autosave manifest when there's no active
   * project save dir to copy from. Caller should pass a snapshot to avoid
   * tearing if a module-import IPC mutates the live state mid-await.
   */
  pendingImports: ProjectModuleImport[];
  /** In-memory per-alias module settings; same snapshotting concern. */
  pendingSettings: Record<string, Record<string, unknown>>;
  /** Kernel language, used when synthesizing a manifest from scratch. */
  language: "python" | "julia";
  /** PDV protocol/app version stamp for the synthesized manifest. */
  pdvVersion: string;
}

/**
 * Mirror module-owned working-dir files into `<autosaveDir>/modules/`,
 * write per-module manifests into the same tree, and stamp a project.json
 * snapshot so unsaved-session recovery can restore module bindings.
 *
 * For a saved project the manifest is copied verbatim from
 * `<activeProjectDir>/project.json`; for an unsaved project it is
 * synthesized from `manifestSource.pendingImports`/`pendingSettings`.
 *
 * Errors writing the manifest are logged but never thrown — the kernel-side
 * tree write (the authoritative part of the autosave) has already succeeded
 * by the time this runs, and a missing project.json snapshot only degrades
 * recovery (the user can still Save As, just without auto-rebinding modules).
 *
 * @param autosaveDir - The `.autosave/` directory to write into.
 * @param result - Kernel response fields the sidecars need.
 * @param manifestSource - Snapshot of relevant main-process state.
 * @param moduleManager - Used by `writeModuleManifestsToSaveDir` to fall back
 *   to globally-installed module metadata when the autosave dir doesn't yet
 *   carry per-module manifests.
 */
export async function mirrorAutosaveSidecars(
  autosaveDir: string,
  result: AutosaveResult,
  manifestSource: AutosaveManifestSource,
  moduleManager: ModuleManager,
): Promise<void> {
  // Mirror module-owned files + per-module manifests. For saved projects this
  // is partly redundant with `<saveDir>/modules/`, but doing it unconditionally
  // keeps `.autosave/` self-sufficient as a recovery source.
  await syncModuleOwnedFilesToSaveDir(autosaveDir, result.moduleOwnedFiles);
  await writeModuleManifestsToSaveDir(autosaveDir, result.moduleManifests, moduleManager);

  // Project.json snapshot. setupProjectModuleNamespaces (and the kernel-side
  // _early_module_setup) consult this during recovery to rebind imports.
  let manifest: ProjectManifest | null = null;
  if (manifestSource.activeProjectDir) {
    try {
      manifest = await ProjectManager.readManifest(manifestSource.activeProjectDir);
    } catch {
      // Saved project but manifest unreadable (concurrent edit, permissions);
      // fall through to synthesizing one below so recovery isn't completely
      // blind to imports.
    }
  }
  if (!manifest) {
    manifest = {
      schema_version: "1.1",
      saved_at: new Date().toISOString(),
      pdv_version: manifestSource.pdvVersion,
      tree_checksum: result.checksum,
      language: manifestSource.language,
      modules: [...manifestSource.pendingImports],
      module_settings: { ...manifestSource.pendingSettings },
    };
  }
  try {
    await ProjectManager.saveManifest(autosaveDir, manifest);
  } catch (err) {
    console.warn("[autosave] failed to write project.json snapshot", err);
  }
}

/** Re-export so consumers that import everything autosave-related from one
 * place can find the autosave dir convention helper. */
export function autosaveDirFor(baseDir: string): string {
  return path.join(baseDir, ".autosave");
}
