#!/usr/bin/env node
/**
 * build-pdv-wheel.mjs — Build the `pdv-python` wheel for bundling.
 *
 * Runs `uv build --wheel` against `pdv-python/` and places the resulting
 * `.whl` in electron/resources/pdv-python-wheel/. The uv-mode kernel boot
 * installs this wheel into each project venv (ARCHITECTURE.md §10.5.7).
 *
 * Prefers the uv binary fetched by fetch-uv.mjs; falls back to a `uv` on
 * PATH. Wired into the `prebuild` npm script, after fetch-uv.mjs.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(electronRoot, "..");
const pdvPythonDir = path.join(repoRoot, "pdv-python");
const outDir = path.join(electronRoot, "resources", "pdv-python-wheel");

if (!fs.existsSync(path.join(pdvPythonDir, "pyproject.toml"))) {
  console.error(`[build-pdv-wheel] pdv-python not found at ${pdvPythonDir}`);
  process.exit(1);
}

/**
 * Resolve a uv binary: the one fetched for the host platform, else `uv` on PATH.
 *
 * @returns {string} Path to a uv executable, or the bare command `uv`.
 */
function resolveUv() {
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  const hostKey = `${process.platform}-${process.arch}`;
  const fetched = path.join(electronRoot, "resources", "uv", hostKey, exe);
  return fs.existsSync(fetched) ? fetched : "uv";
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log(`[build-pdv-wheel] building wheel from ${pdvPythonDir}...`);
execFileSync(
  resolveUv(),
  ["build", pdvPythonDir, "--wheel", "--out-dir", outDir],
  { stdio: "inherit" }
);

const wheels = fs.readdirSync(outDir).filter((name) => name.endsWith(".whl"));
if (wheels.length === 0) {
  console.error("[build-pdv-wheel] no wheel was produced.");
  process.exit(1);
}
console.log(`[build-pdv-wheel] built → resources/pdv-python-wheel/${wheels[0]}`);
