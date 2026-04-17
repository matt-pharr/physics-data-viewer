/**
 * note-files.ts — Resolve and read/write markdown note backing files.
 *
 * Responsibilities:
 * - Map a dot-delimited tree path to its `.md` file path under a root dir.
 * - Read a note either from the kernel working dir or from the loaded project.
 * - Write note content into the kernel working dir backing file.
 *
 * Non-responsibilities:
 * - IPC registration.
 * - Renderer state management.
 * - Project save/load orchestration.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { NoteReadOptions } from "./ipc";

/**
 * Resolve a markdown note's backing file path under a root directory.
 *
 * @param rootDir - Working dir or project dir root.
 * @param treePath - Dot-delimited tree path of the note node.
 * @returns Absolute `.md` file path.
 * @throws {Error} If the tree path is invalid.
 */
export function resolveNoteFilePath(rootDir: string, treePath: string): string {
  const segments = treePath.split(".").filter(Boolean);
  const lastSeg = segments.pop();
  if (!lastSeg) {
    throw new Error("Invalid tree path");
  }
  const noteDir = segments.length > 0
    ? path.join(rootDir, "tree", ...segments)
    : path.join(rootDir, "tree");
  return path.join(noteDir, `${lastSeg}.md`);
}

/**
 * Read note content from disk, optionally preferring the loaded project's file.
 *
 * @param options - Read target selection and tree path info.
 * @returns File contents as UTF-8 text.
 * @throws {Error} If the requested file cannot be read and no fallback exists.
 */
export async function readNoteFile(options: {
  workingDir: string;
  projectDir?: string | null;
  treePath: string;
  readOptions?: NoteReadOptions;
}): Promise<string> {
  const { workingDir, projectDir, treePath, readOptions } = options;
  if (readOptions?.source === "project" && projectDir) {
    try {
      return await fs.readFile(resolveNoteFilePath(projectDir, treePath), "utf-8");
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") {
        throw err;
      }
    }
  }
  return fs.readFile(resolveNoteFilePath(workingDir, treePath), "utf-8");
}

/**
 * Write note content into the kernel working directory backing file.
 *
 * @param workingDir - Active kernel working directory.
 * @param treePath - Dot-delimited tree path of the note node.
 * @param content - Full markdown content to persist.
 * @returns Promise that resolves once the file is written.
 * @throws {Error} If the path is invalid or the write fails.
 */
export async function writeNoteFile(
  workingDir: string,
  treePath: string,
  content: string,
): Promise<void> {
  const filePath = resolveNoteFilePath(workingDir, treePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}
