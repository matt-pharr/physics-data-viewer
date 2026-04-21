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
          (storage.uuid as string).length > 0
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
export async function copyFilesForLoad(
  saveDir: string,
  workingDir: string,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const entries = await readFileBackedEntries(saveDir);
  const total = entries.length;
  for (let i = 0; i < total; i++) {
    const { uuid, filename } = entries[i];
    const relativePath = path.join("tree", uuid, filename);
    const src = path.join(saveDir, relativePath);
    const dest = path.join(workingDir, relativePath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest).catch((error) => {
      console.warn(`[pdv] load: could not copy ${src}`, error);
    });
    if (onProgress && (i % 5 === 0 || i === total - 1)) {
      onProgress(i + 1, total);
    }
  }
}
