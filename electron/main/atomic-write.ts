/**
 * atomic-write.ts — Crash-safe file writes for the project save pipeline.
 *
 * Responsibilities:
 * - Provide write/copy primitives that either fully succeed or leave the
 *   destination untouched. Used for every persistent JSON artifact in a
 *   project save (``project.json``, ``code-cells.json``, ``pdv-module.json``,
 *   ``module-index.json``) and for copying module-owned files into the
 *   project ``modules/`` tree.
 *
 * Implementation strategy:
 *   1. Write the new bytes to a sibling ``<dest>.tmp`` file.
 *   2. ``rename`` the temp file over the destination. POSIX guarantees this
 *      step is atomic when source and destination are on the same volume —
 *      which is always true here because the temp file is a sibling.
 *
 * On Windows, Node's ``fs.rename`` uses ``MoveFileEx`` with
 * ``MOVEFILE_REPLACE_EXISTING``; it is also atomic on the same volume.
 * The realistic edge case is when the destination is held open by
 * another process (antivirus scanning the file, an editor with a
 * handle), in which case ``rename`` can fail with ``EBUSY``. Our
 * cleanup removes the temp and propagates the error; the destination
 * is never left torn either way.
 *
 * After a process crash mid-write, the destination file is either
 * fully-old or fully-new; never torn. A stale ``.tmp`` may remain on
 * disk; it is harmless and gets overwritten on the next save. Matches
 * the kernel-side pattern for ``tree-index.json`` in
 * ``pdv-python/pdv/handlers/project.py:826-830``.
 *
 * Non-responsibilities:
 * - Cross-file consistency (e.g. ``project.json`` and ``tree-index.json``
 *   referring to the same version). The save pipeline orders writes so
 *   that ``project.json`` is the last file committed; if it parses, all
 *   preceding writes are done.
 * - Directory ``fsync`` for power-loss durability. Process crashes are
 *   covered; whole-machine power loss on Linux ext4 may still lose the
 *   most recent rename. Acceptable tradeoff for now; see
 *   ``docs/developer/save-pipeline.md``.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §8 (save/load protocol),
 * ``pdv-python/pdv/handlers/project.py:826-830`` for the kernel-side
 * equivalent (``tree-index.json`` temp+replace).
 */

import * as fs from "fs/promises";
import * as path from "path";

/**
 * Suffix appended to the destination path when staging a write.
 *
 * Kept short and predictable so any stale temp files left by a crashed
 * save are easy to spot in the save directory.
 */
const TMP_SUFFIX = ".tmp";

/**
 * Atomically write ``data`` to ``filePath``.
 *
 * Creates the parent directory on demand. The destination is either
 * fully replaced with the new contents or left untouched on any error.
 *
 * @param filePath - Absolute path of the file to write.
 * @param data - Contents to write. ``string`` is encoded as UTF-8 unless
 *   ``encoding`` is overridden; ``Buffer`` is written verbatim.
 * @param encoding - Encoding for string ``data``. Ignored when ``data``
 *   is a ``Buffer``.
 * @returns Nothing.
 * @throws {Error} When the parent directory cannot be created, the temp
 *   file cannot be written, or the rename fails. The temp file is
 *   removed before the error propagates.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + TMP_SUFFIX;
  try {
    if (typeof data === "string") {
      await fs.writeFile(tmp, data, encoding);
    } else {
      await fs.writeFile(tmp, data);
    }
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Atomically serialize ``value`` to ``filePath`` as JSON.
 *
 * Thin wrapper around {@link atomicWriteFile} that handles the
 * stringification consistently — two-space indent, trailing newline —
 * to match the existing on-disk format of project artifacts. The
 * trailing ``\n`` matches POSIX text-file convention and the prior
 * shape of ``pdv-module.json`` / ``module-index.json`` (the only
 * artifacts that previously appended one); ``project.json`` and
 * ``code-cells.json`` now gain it too, which is a one-byte cosmetic
 * improvement on the next save.
 *
 * Callers that need a different shape should call
 * {@link atomicWriteFile} directly.
 *
 * @param filePath - Absolute path of the JSON file to write.
 * @param value - JSON-serializable value.
 * @param indent - Indentation passed to ``JSON.stringify``. Defaults to 2.
 * @returns Nothing.
 * @throws {Error} Propagates errors from {@link atomicWriteFile} and
 *   from ``JSON.stringify`` (e.g. circular references).
 */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  indent: number = 2,
): Promise<void> {
  const body = JSON.stringify(value, null, indent) + "\n";
  await atomicWriteFile(filePath, body, "utf8");
}

/**
 * Atomically copy a file from ``src`` to ``dst``.
 *
 * Creates the destination's parent directory on demand. The destination
 * is either fully replaced with ``src``'s contents or left untouched on
 * any error.
 *
 * Used by ``syncModuleOwnedFilesToSaveDir`` in
 * ``ipc-register-project.ts`` so that mirroring an edited module-owned
 * file (script, lib, gui, namelist, generic file) into
 * ``<saveDir>/modules/<id>/<source_rel_path>`` cannot leave a torn copy
 * if the process dies mid-copy.
 *
 * @param src - Absolute path of the source file.
 * @param dst - Absolute path of the destination file.
 * @returns Nothing.
 * @throws {Error} When the parent directory cannot be created, ``src``
 *   cannot be read, the temp file cannot be written, or the rename
 *   fails. The temp file is removed before the error propagates.
 */
export async function atomicCopyFile(src: string, dst: string): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  const tmp = dst + TMP_SUFFIX;
  try {
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dst);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
