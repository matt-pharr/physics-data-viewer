/**
 * bundle-server.mjs — The one place the pdv-server bundle is produced.
 *
 * Two builds need the identical bundle: the local one electron-builder
 * ships to `<Resources>/pdv-server/`, and the per-arch tarball uploaded to a
 * remote host. If those ever diverged, local and remote sessions would run
 * different code while reporting the same version — the kind of discrepancy
 * that produces bug reports nobody can reproduce. So both call this.
 *
 * `zeromq` stays external: it is a native module, resolved at runtime from
 * the asar-unpacked copy locally (via `PDV_ZEROMQ_PATH`) and from the
 * vendored linux prebuild inside the tarball remotely.
 *
 * The version is baked in as `process.env.PDV_BUILD_VERSION`. Without it,
 * both sides of the hello check derive from the same running app and a stale
 * bundle would pass; baked, it is the only value that can disagree, which is
 * what makes the check mean anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { build } from "esbuild";

/**
 * Bundle `server-main.js` and its import closure into one CommonJS file.
 *
 * @param {object} options
 * @param {string} options.entry - Path to the compiled `server-main.js`.
 * @param {string} options.outfile - Destination `.cjs` path.
 * @param {string} options.version - Version baked in as `PDV_BUILD_VERSION`.
 * @param {boolean} [options.clean=true] - Wipe the output directory first.
 *   A stale bundle is invisible once copied, so this defaults on.
 * @returns {Promise<number>} Size of the produced bundle in bytes.
 * @throws {Error} When the entry point is missing or esbuild fails.
 */
export async function bundleServer({ entry, outfile, version, clean = true }) {
  if (!fs.existsSync(entry)) {
    throw new Error(`${entry} not found — run \`npm run build:main\` first.`);
  }
  if (!version) {
    throw new Error("a version is required (it is baked into the bundle)");
  }

  const outDir = path.dirname(outfile);
  if (clean) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["zeromq"],
    define: {
      "process.env.PDV_BUILD_VERSION": JSON.stringify(version),
    },
    logLevel: "warning",
  });

  return fs.statSync(outfile).size;
}
