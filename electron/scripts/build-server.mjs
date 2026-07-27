#!/usr/bin/env node
/**
 * build-server.mjs — Bundle the pdv-server for packaged builds.
 *
 * esbuild-bundles the tsc output (`dist/main/server/server-main.js`) into a
 * single `dist/server-bundle/pdv-server.cjs`, which electron-builder ships
 * to `<Resources>/pdv-server/` (ARCHITECTURE.md §2.1.1). The child runs
 * under plain Node via `ELECTRON_RUN_AS_NODE`, which cannot `require()`
 * from inside app.asar, so it must be a real file on disk.
 *
 * `zeromq` is left external — it is a native module, resolved at runtime
 * from the asar-unpacked copy via `PDV_ZEROMQ_PATH`.
 *
 * Two things this does that a bare esbuild invocation would not:
 *
 * 1. Wipes the output directory first. Nothing else invalidates a stale
 *    bundle, and electron-builder copies the directory opaquely — a bundle
 *    left over from an earlier build would ship silently.
 * 2. Bakes the version into the bundle (`process.env.PDV_BUILD_VERSION`)
 *    from package.json. The runtime hello check compares the shell's
 *    `app.getVersion()` against what the server reports; without a baked
 *    value both sides derive from the same live app, so the check cannot
 *    fail and a stale bundle would pass it. Reading package.json here keeps
 *    the version in exactly one place (the unified-version rule — never
 *    hand-write it, see scripts/bump-version.sh).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleServer } from "./lib/bundle-server.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, "..");

const entry = path.join(electronRoot, "dist", "main", "server", "server-main.js");
const outDir = path.join(electronRoot, "dist", "server-bundle");
const outfile = path.join(outDir, "pdv-server.cjs");

const { version } = JSON.parse(
  fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"),
);
if (!version) {
  console.error("[build-server] package.json has no version");
  process.exit(1);
}

let bytes;
try {
  bytes = await bundleServer({ entry, outfile, version });
} catch (error) {
  console.error(`[build-server] ${error.message}`);
  process.exit(1);
}

console.log(
  `[build-server] pdv-server.cjs ${(bytes / 1024 / 1024).toFixed(1)} MB (version ${version})`,
);
