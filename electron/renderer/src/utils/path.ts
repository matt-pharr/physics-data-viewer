/**
 * path.ts — Separator-aware helpers for server-side paths shown or built in
 * the renderer.
 *
 * The renderer has no `path` module, and the platform it runs on is not the
 * platform that interprets the path: a remote session from a Windows laptop
 * targets a POSIX host. So the separator is inferred from the path itself —
 * a drive-letter (`C:\`) or UNC (`\\server`) path is Windows-style, anything
 * else is POSIX.
 */

/**
 * The separator native to `p`.
 *
 * @param p - An absolute path.
 * @returns `\` for Windows-style paths, `/` otherwise.
 */
export function pathSeparatorFor(p: string): '/' | '\\' {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(p) ? '\\' : '/';
}

/**
 * Join a child name onto a directory using the directory's own separator.
 *
 * @param dir - Parent directory.
 * @param name - A single path segment.
 * @returns `dir` + separator + `name` (no doubled separator).
 */
export function joinPath(dir: string, name: string): string {
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}${pathSeparatorFor(dir)}${name}`;
}

/**
 * Last segment of a path, accepting either separator.
 *
 * @param p - A path.
 * @returns The final non-empty segment, or `p` when it has none.
 */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Parent directory of a path, keeping its native separator and root
 * (`/`, `C:\`, or `\\server\share`).
 *
 * @param p - An absolute path.
 * @returns The parent directory, or `p` when it has no parent.
 */
export function dirName(p: string): string {
  // A UNC share root (`\\server\share`) is itself a root: it has no parent.
  if (/^\\\\[^\\/]+[\\/][^\\/]+[\\/]*$/.test(p)) return p;
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return p;
  const parent = trimmed.slice(0, idx);
  // Keep the root's separator: "/a" → "/", "C:\a" → "C:\".
  if (parent === '' || /^[A-Za-z]:$/.test(parent)) return trimmed.slice(0, idx + 1);
  return parent;
}
