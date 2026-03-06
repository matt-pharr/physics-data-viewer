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
  path: string;
  filename: string;
}

/**
 * Read tree-index.json from a directory and return entries that have a filename
 * (i.e. file-backed nodes).
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
      .filter((entry) => typeof entry.filename === "string" && entry.filename.length > 0)
      .map((entry) => ({
        path: String(entry.path ?? ""),
        filename: entry.filename as string,
      }));
  } catch (error) {
    console.warn(
      `[pdv] could not read file-backed entries from ${dir}/tree-index.json`,
      error
    );
    return [];
  }
}

/**
 * Copy file-backed node files from the kernel working directory into the save directory.
 *
 * Called after the kernel has written tree-index.json to saveDir.
 *
 * @param workingDir - Kernel working directory (source).
 * @param saveDir - Project save directory (destination).
 * @returns Nothing.
 * @throws {Error} When directory creation fails.
 */
export async function copyFilesForSave(workingDir: string, saveDir: string): Promise<void> {
  const nodes = await readFileBackedEntries(saveDir);
  for (const { path: nodePath, filename } of nodes) {
    const segs = nodePath.split(".").filter(Boolean);
    const src = path.join(workingDir, ...segs, filename);
    const destDir = path.join(saveDir, ...segs);
    const dest = path.join(destDir, filename);
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(src, dest).catch((error) => {
      console.warn(`[pdv] save: could not copy ${src}`, error);
    });
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
export async function copyFilesForLoad(saveDir: string, workingDir: string): Promise<void> {
  const nodes = await readFileBackedEntries(saveDir);
  for (const { path: nodePath, filename } of nodes) {
    const segs = nodePath.split(".").filter(Boolean);
    const src = path.join(saveDir, ...segs, filename);
    const destDir = path.join(workingDir, ...segs);
    const dest = path.join(destDir, filename);
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(src, dest).catch((error) => {
      console.warn(`[pdv] load: could not copy ${src}`, error);
    });
  }
}
