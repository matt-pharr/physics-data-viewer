/**
 * project-file-sync.ts — File-backed tree node copy helpers for project save/load.
 *
 * Responsibilities:
 * - Read `tree-index.json` and resolve file-backed node descriptors.
 * - Copy file-backed node files from working directory to project save directory.
 * - Copy file-backed node files from project save directory to working directory.
 *
 * Non-responsibilities:
 * - Triggering project save/load protocol messages.
 * - Managing kernel lifecycle or IPC registration.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { resolveNodePath } from "./pdv-protocol";

/** Matches a valid 12-hex-character node UUID. */
const UUID_RE = /^[0-9a-f]{12}$/;

/**
 * One file-backed tree entry resolved from `tree-index.json`.
 */
interface FileBackedEntry {
  treePath: string;
  uuid: string;
  filename: string;
}

/**
 * Read tree-index.json from a directory and return entries that have a
 * `storage.uuid` and `storage.filename` (i.e. file-backed nodes).
 *
 * @param dir - Directory containing tree-index.json.
 * @returns Array of file-backed node descriptors.
 */
async function readFileBackedEntries(dir: string): Promise<FileBackedEntry[]> {
  try {
    const raw = await fs.readFile(path.join(dir, "tree-index.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>)
      .filter((entry) => {
        const storage = entry.storage as Record<string, unknown> | undefined;
        return (
          storage?.backend === "local_file" &&
          typeof storage?.uuid === "string" &&
          typeof storage?.filename === "string" &&
          UUID_RE.test(storage.uuid as string)
        );
      })
      .map((entry) => {
        const storage = entry.storage as Record<string, unknown>;
        return {
          treePath: String(entry.path ?? ""),
          uuid: storage.uuid as string,
          filename: storage.filename as string,
        };
      });
  } catch (error) {
    console.warn(
      `[pdv] could not read file-backed entries from ${dir}/tree-index.json`,
      error
    );
    return [];
  }
}

/**
 * Copy file-backed node files from the save directory into the kernel working directory.
 *
 * Called before sending pdv.project.load so files exist when the kernel reads them.
 *
 * @param saveDir - Project save directory (source).
 * @param workingDir - Kernel working directory (destination).
 * @returns Nothing.
 * @throws {Error} When directory creation fails.
 */
/**
 * Overlay autosaved file-backed-node files on top of a working directory.
 *
 * Used by the saved-project recovery flow when the user opts to "restore
 * autosaved changes." After {@link copyFilesForLoad} has populated the
 * working dir from `<saveDir>/tree/`, this helper recursively copies
 * whatever exists under `<autosaveDir>/tree/` over the same destination
 * tree — overwriting only the UUIDs the autosave actually wrote new files
 * for. Cache-hit UUIDs (whose canonical files live in `<saveDir>/tree/`)
 * are deliberately *not* listed in `<autosaveDir>/tree/` and so are left
 * alone here, which is the correct behaviour: the canonical file copied
 * by `copyFilesForLoad` is already what we want.
 *
 * Distinct from `copyFilesForLoad`: that variant reads tree-index.json
 * and copies a known list of UUIDs, surfacing missing files as warnings
 * to the user. For an overlay, missing files (cache hits) aren't an
 * error, so directory-style copy is the right primitive.
 *
 * @param autosaveDir - Source `.autosave/` directory.
 * @param workingDir - Destination kernel working directory.
 * @returns Nothing. Quietly no-ops if `<autosaveDir>/tree/` doesn't exist.
 * @throws {Error} For any I/O error other than ENOENT on the source root.
 */
export async function overlayAutosaveTreeFiles(
  autosaveDir: string,
  workingDir: string,
): Promise<void> {
  const src = path.join(autosaveDir, "tree");
  const dst = path.join(workingDir, "tree");
  try {
    await fs.cp(src, dst, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw err;
    // .autosave/tree/ doesn't exist — every data node hit the cache and no
    // fresh writes happened since the last explicit save. Nothing to overlay.
  }
}

export async function copyFilesForLoad(
  saveDir: string,
  workingDir: string,
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {
  const entries = await readFileBackedEntries(saveDir);
  const total = entries.length;
  const failedPaths: string[] = [];
  for (let i = 0; i < total; i++) {
    const { uuid, filename, treePath } = entries[i];
    const src = resolveNodePath(saveDir, uuid, filename);
    const dest = resolveNodePath(workingDir, uuid, filename);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest).catch((error) => {
      console.warn(`[pdv] load: could not copy ${src}`, error);
      failedPaths.push(treePath);
    });
    if (onProgress && (i % 5 === 0 || i === total - 1)) {
      onProgress(i + 1, total);
    }
  }
  return failedPaths;
}

/**
 * uv environment files that travel between the save dir and working dir.
 * `.python-version` is uv's native interpreter pin, written at project
 * creation from the New Project dialog's version choice; carrying it here
 * makes the pinned version survive save → open round-trips.
 */
const ENV_FILES = ["pyproject.toml", "uv.lock", ".python-version"];

/**
 * Copy uv environment files (`pyproject.toml`, `uv.lock`,
 * `.python-version`) from the project save directory into the kernel
 * working directory.
 *
 * Called for `mode: "uv"` projects before `uv sync` so the working directory
 * is a self-contained uv project (ARCHITECTURE.md §10.5.3, §10.5.9). Files
 * absent from the save directory are skipped silently.
 *
 * @param saveDir - Project save directory (source).
 * @param workingDir - Kernel working directory (destination).
 * @returns Relative names of the files that were copied.
 * @throws {Error} For any I/O error other than a missing source file.
 */
export async function copyEnvFilesForLoad(
  saveDir: string,
  workingDir: string
): Promise<string[]> {
  const copied: string[] = [];
  for (const name of ENV_FILES) {
    try {
      await fs.copyFile(path.join(saveDir, name), path.join(workingDir, name));
      copied.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  return copied;
}

/**
 * Copy uv environment files (`pyproject.toml`, `uv.lock`,
 * `.python-version`) from the kernel working directory back into the
 * project save directory (§10.5.10).
 *
 * Only files present in the working directory are copied — a project whose
 * `uv sync` failed may have no `uv.lock`, and a missing working-dir file must
 * never clobber a good saved one.
 *
 * @param workingDir - Kernel working directory (source).
 * @param saveDir - Project save directory (destination).
 * @returns Relative names of the files that were copied.
 * @throws {Error} For any I/O error other than a missing source file.
 */
export async function copyEnvFilesForSave(
  workingDir: string,
  saveDir: string
): Promise<string[]> {
  const copied: string[] = [];
  for (const name of ENV_FILES) {
    try {
      await fs.copyFile(path.join(workingDir, name), path.join(saveDir, name));
      copied.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  return copied;
}

/**
 * Compare every env file between two directories, byte for byte. Files
 * missing from both sides count as matching; a file present on only one
 * side does not.
 *
 * @param dirA - First directory.
 * @param dirB - Second directory.
 * @returns True when all of `ENV_FILES` are identical across the two dirs.
 */
async function envFilesMatch(dirA: string, dirB: string): Promise<boolean> {
  for (const name of ENV_FILES) {
    let a: Buffer | null = null;
    let b: Buffer | null = null;
    try {
      a = await fs.readFile(path.join(dirA, name));
    } catch {
      // Missing on side A.
    }
    try {
      b = await fs.readFile(path.join(dirB, name));
    } catch {
      // Missing on side B.
    }
    if (a === null && b === null) continue;
    if (a === null || b === null || !a.equals(b)) return false;
  }
  return true;
}

/** Result of {@link syncUvEnvironmentForLoad}. */
export interface LoadEnvSyncResult {
  /** Env-file names copied from the save dir into the working dir. */
  copied: string[];
  /** True when `uv sync` ran and succeeded, so the venv matches the project. */
  synced: boolean;
  /** Human-readable warning when the venv could not be brought in sync. */
  warning?: string;
}

/**
 * Bring a running uv session's environment in line with a project being
 * opened into it (`project:load` with a kernel already running).
 *
 * Without this, the working dir keeps the *previous* project's
 * `pyproject.toml`/`uv.lock`: the kernel can't import the opened project's
 * packages, the Project Environment tab lists the wrong dependencies, and —
 * worst — a subsequent save copies the stale env files into the opened
 * project's save dir, silently clobbering its environment spec.
 *
 * In the standard flow this is a fast no-op: opening a project always starts
 * a fresh kernel whose working dir was just materialized from the save dir,
 * so the env files already match (step 2) and no uv run happens. The copy +
 * sync below is the safety net for any `project:load` caller whose working
 * dir predates the opened project.
 *
 * Steps:
 * 1. No-op (empty result) when the save dir has no `pyproject.toml` — the
 *    project wasn't saved as a uv project, and copying nothing keeps the
 *    prior behavior for legacy/shared-mode saves.
 * 2. Short-circuit (synced, nothing copied) when every env file in the save
 *    dir is byte-identical to the working dir's — the venv was materialized
 *    from these exact files.
 * 3. Copy `ENV_FILES` from the save dir into the working dir. This alone
 *    fixes the save-clobber hazard and the Packages tab's declared-deps list.
 * 4. If the project pins a Python version different from the running
 *    session's, skip the sync and return a warning — an in-place `uv sync`
 *    would rebuild the venv on a different interpreter under the live
 *    kernel (C-extension ABI hazard). A session restart rebuilds correctly
 *    from the working-dir env snapshot.
 * 5. Otherwise run `uv sync` (injected, callers pass `--inexact` so
 *    pdv-python survives) in the working dir so the venv matches the
 *    project's lockfile.
 *
 * @param saveDir - Project save directory being opened.
 * @param workingDir - Active kernel's working directory.
 * @param options - Injected sync runner and the running session's Python
 *   version (major.minor) for the pin-mismatch guard.
 * @returns Copy/sync outcome plus an optional user-facing warning.
 * @throws {Error} Only for unexpected I/O errors while copying env files.
 */
export async function syncUvEnvironmentForLoad(
  saveDir: string,
  workingDir: string,
  options: {
    runningPythonVersion?: string;
    runUvSync: (cwd: string) => Promise<{ success: boolean; output: string }>;
  },
): Promise<LoadEnvSyncResult> {
  try {
    await fs.access(path.join(saveDir, "pyproject.toml"));
  } catch {
    return { copied: [], synced: false };
  }

  if (await envFilesMatch(saveDir, workingDir)) {
    return { copied: [], synced: true };
  }

  const copied = await copyEnvFilesForLoad(saveDir, workingDir);

  let pinnedVersion: string | undefined;
  try {
    pinnedVersion = (await fs.readFile(path.join(saveDir, ".python-version"), "utf8")).trim();
  } catch {
    // No pin — sync with the session's interpreter.
  }
  if (
    pinnedVersion &&
    options.runningPythonVersion &&
    !pinnedVersion.startsWith(options.runningPythonVersion)
  ) {
    return {
      copied,
      synced: false,
      warning:
        `This project pins Python ${pinnedVersion} but the session is running ` +
        `Python ${options.runningPythonVersion}. Restart the session to rebuild ` +
        `its environment for this project.`,
    };
  }

  const sync = await options.runUvSync(workingDir);
  if (!sync.success) {
    return {
      copied,
      synced: false,
      warning:
        "uv sync failed while updating the session environment for this project — " +
        "its packages may be unavailable until the environment is repaired.",
    };
  }
  return { copied, synced: true };
}
