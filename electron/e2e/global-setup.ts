/**
 * global-setup.ts — Pre-flight assertions before any E2E spec runs.
 *
 * Refuses to start if the prod bundle hasn't been built or PYTHON_PATH isn't
 * pointed at a Python that has pdv installed. Failing here gives a clear
 * error message instead of an opaque Electron crash.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ELECTRON_ROOT = path.resolve(__dirname, "..");
const FIXTURES_CACHE = path.join(ELECTRON_ROOT, "e2e", ".fixtures-cache");
const MPL_CACHE_DIR = path.join(FIXTURES_CACHE, "matplotlib");

/**
 * Prime the matplotlib font cache under our pinned MPLCONFIGDIR so the first
 * spec run doesn't blow the 15s pdv.bootstrap timeout while matplotlib
 * rebuilds fonts. This runs once per `npm run test:e2e` invocation; the cache
 * is reused across runs unless the user nukes `e2e/.fixtures-cache/`.
 */
function primeMatplotlibCache(pythonPath: string): void {
  const fontList = path.join(MPL_CACHE_DIR, "fontlist-v390.json");
  if (fs.existsSync(fontList)) return;
  fs.mkdirSync(MPL_CACHE_DIR, { recursive: true });
  const result = spawnSync(
    pythonPath,
    ["-c", "import matplotlib.pyplot"],
    { env: { ...process.env, MPLCONFIGDIR: MPL_CACHE_DIR }, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `[e2e:global-setup] Failed to prime matplotlib font cache (exit ${result.status}).`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  const bootstrap = path.join(ELECTRON_ROOT, "dist", "main", "bootstrap.js");
  const rendererIndex = path.join(ELECTRON_ROOT, "renderer", "dist", "index.html");

  for (const required of [bootstrap, rendererIndex]) {
    if (!fs.existsSync(required)) {
      throw new Error(
        `[e2e:global-setup] Missing build artifact: ${required}\n` +
          `Run \`npm run build:e2e\` from the electron/ directory before running E2E tests.`,
      );
    }
  }

  const pythonPath = process.env.PYTHON_PATH;
  if (!pythonPath) {
    throw new Error(
      "[e2e:global-setup] PYTHON_PATH is not set.\n" +
        "Point it at a Python with pdv installed, e.g.:\n" +
        "    PYTHON_PATH=/path/to/python npm run test:e2e",
    );
  }

  fs.mkdirSync(FIXTURES_CACHE, { recursive: true });
  primeMatplotlibCache(pythonPath);
}
