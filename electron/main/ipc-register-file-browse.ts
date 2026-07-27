/**
 * ipc-register-file-browse.ts — the `files:listDir` handler.
 *
 * The remote path picker's one data source: lists a directory on the
 * machine the session runs on. Its native-dialog siblings
 * (`files:pickDirectory` …) are shell channels that browse the window's
 * machine; this one is a server channel precisely because the filesystem
 * that matters is the session's.
 *
 * Deliberately minimal — one read-only channel, no stat, no mkdir, no
 * watching. The picker this feeds is a placeholder for the planned
 * command-palette UI, so the server surface stays as small as the UI.
 *
 * This module does NOT register any other channel, and never writes to the
 * filesystem.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { IPC, type ListDirEntry, type ListDirResult } from "./ipc";
import { handleInvoke } from "./server/invoke-registry";

/**
 * Expand a leading `~` to the home directory.
 *
 * @param input - A user-typed path.
 * @param home - The home directory to expand to.
 * @returns The expanded path.
 */
function expandTilde(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

/**
 * Register the `files:listDir` invoke handler.
 *
 * @returns Nothing.
 * @throws {Error} Never synchronously; the handler itself rejects with the
 *   filesystem error (ENOENT, EACCES, ENOTDIR) for the picker to display.
 */
export function registerFileBrowseIpcHandlers(): void {
  handleInvoke(
    IPC.files.listDir,
    async (_ctx, dirPath?: string): Promise<ListDirResult> => {
      const home = os.homedir();
      const trimmed = typeof dirPath === "string" ? dirPath.trim() : "";
      const target = path.resolve(trimmed ? expandTilde(trimmed, home) : home);

      const dirents = await fs.readdir(target, { withFileTypes: true });
      const entries: ListDirEntry[] = [];
      for (const entry of dirents) {
        let kind: "dir" | "file";
        if (entry.isSymbolicLink()) {
          try {
            kind = (await fs.stat(path.join(target, entry.name))).isDirectory()
              ? "dir"
              : "file";
          } catch {
            // Dangling link: not listable, not selectable — skip it.
            continue;
          }
        } else {
          kind = entry.isDirectory() ? "dir" : "file";
        }
        entries.push({ name: entry.name, kind });
      }
      entries.sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === "dir"
            ? -1
            : 1,
      );
      return { path: target, entries, home };
    },
  );
}
