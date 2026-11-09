#!/usr/bin/env node
/**
 * fix-node-pty-perms.mjs — Restore the executable bit on node-pty's
 * `spawn-helper`.
 *
 * node-pty 1.1.0 publishes its `prebuilds/<platform>-<arch>/spawn-helper`
 * with mode 644 in the npm tarball, and its own `postinstall` only tidies
 * `build/Release` — the path taken when the module is compiled from source,
 * not the prebuild path a plain `npm install` actually uses. On macOS and
 * Linux, `UnixTerminal` execs that helper to set up the pty, so a
 * non-executable copy makes every `pty.spawn()` fail with the singularly
 * unhelpful `posix_spawnp failed.`
 *
 * Left unfixed this breaks three separate things — the remote connect flow
 * in development, the unit tests that spawn a real pty, and the packaged
 * app (electron-builder copies the mode it finds) — so the repair belongs
 * at install time rather than in any one of them.
 *
 * Idempotent, and silent when there is nothing to do: safe to run on every
 * install, on Windows (which uses conpty and no helper), and in a tree where
 * node-pty is not installed at all.
 *
 * Usage: node scripts/fix-node-pty-perms.mjs
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodePtyDir = path.join(here, "..", "node_modules", "node-pty");

/** Directories that may hold a `spawn-helper`, relative to the package root. */
const HELPER_ROOTS = ["prebuilds", path.join("build", "Release")];

/**
 * Collect every `spawn-helper` shipped in the installed node-pty.
 *
 * @returns {string[]} Absolute paths, empty when node-pty is absent.
 */
function findHelpers() {
  const found = [];
  for (const root of HELPER_ROOTS) {
    const dir = path.join(nodePtyDir, root);
    if (!fs.existsSync(dir)) continue;
    const direct = path.join(dir, "spawn-helper");
    if (fs.existsSync(direct)) found.push(direct);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(dir, entry.name, "spawn-helper");
      if (fs.existsSync(nested)) found.push(nested);
    }
  }
  return found;
}

let fixed = 0;
for (const helper of findHelpers()) {
  const mode = fs.statSync(helper).mode & 0o777;
  if ((mode & 0o111) === 0o111) continue;
  fs.chmodSync(helper, mode | 0o755);
  fixed++;
}

if (fixed > 0) {
  console.log(`[fix-node-pty-perms] Made ${fixed} spawn-helper binar${fixed === 1 ? "y" : "ies"} executable.`);
}
