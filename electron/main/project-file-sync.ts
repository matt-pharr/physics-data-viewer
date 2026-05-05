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
