/**
 * launcher-availability.ts — Probe whether a configured launcher is installed.
 *
 * Backs `launchers.checkAvailability`, which the Settings dialog uses to gate
 * the Save button: the user cannot persist a terminal / editor / file-manager
 * selection whose underlying program isn't present.
 *
 * Nothing here launches the program. PATH checks are pure filesystem probes;
 * macOS `.app` checks test standard install locations. No child process is
 * spawned and no window is opened.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { LauncherCheck } from "./ipc";

/**
 * Standard macOS application directories, in search order. An app installed
 * outside these (rare) will report unavailable; the user can fall back to a
 * "Custom" launcher in that case.
 */
function macAppSearchDirs(): string[] {
  return [
    "/Applications",
    path.join(os.homedir(), "Applications"),
    "/System/Applications",
    "/System/Applications/Utilities",
  ];
}

/**
 * Whether `bin` resolves to an executable on `$PATH`. If `bin` already
 * contains a path separator it is probed directly. On Windows, `PATHEXT`
 * extensions are tried and execute-permission is not checked (unreliable
 * there); on POSIX the file must be executable.
 *
 * @param bin - Executable name or path.
 * @returns True when an executable file is found.
 */
export async function isExecutableOnPath(bin: string): Promise<boolean> {
  if (bin.length === 0) return false;
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? [
        "",
        ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean),
      ]
    : [""];

  const probe = async (candidate: string): Promise<boolean> => {
    for (const ext of exts) {
      try {
        if (isWindows) {
          await fs.access(candidate + ext, fs.constants.F_OK);
        } else {
          await fs.access(candidate + ext, fs.constants.X_OK);
        }
        return true;
      } catch {
        /* try next extension */
      }
    }
    return false;
  };

  if (bin.includes("/") || (isWindows && bin.includes("\\"))) {
    return probe(bin);
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await probe(path.join(dir, bin))) return true;
  }
  return false;
}

/**
 * Whether a macOS application bundle named `app` exists in a standard
 * applications directory. `app` is the bundle name without `.app`
 * (e.g. `"Ghostty"`, `"iTerm"`).
 *
 * @param app - Application bundle base name.
 * @returns True when `<dir>/<app>.app` exists in a standard location.
 */
export async function macAppInstalled(app: string): Promise<boolean> {
  for (const dir of macAppSearchDirs()) {
    try {
      await fs.access(path.join(dir, `${app}.app`), fs.constants.F_OK);
      return true;
    } catch {
      /* try next directory */
    }
  }
  return false;
}

/**
 * Resolve a {@link LauncherCheck} to an availability boolean.
 *
 * @param check - The check descriptor from the launcher catalog.
 * @returns True when the launcher is present (always true for `kind: 'none'`).
 */
export async function checkLauncherAvailability(
  check: LauncherCheck,
): Promise<boolean> {
  switch (check.kind) {
    case "none":
      return true;
    case "path":
      return isExecutableOnPath(check.bin);
    case "macapp":
      // `.app` bundles only exist on macOS; a macapp check elsewhere means a
      // config carried across platforms — treat as unavailable.
      return process.platform === "darwin" ? macAppInstalled(check.app) : false;
  }
}
