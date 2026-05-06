/**
 * launch.ts — Spawn the production Electron bundle for E2E tests.
 *
 * Each call creates a fresh temp HOME so the user's real `~/.PDV/preferences.json`
 * is never touched, pre-seeds `pythonPath` from `process.env.PYTHON_PATH` so the
 * renderer can boot a kernel without manual env selection, and sets `PDV_E2E=1`
 * (read by `app.ts` to skip the orphan-working-dir cleanup that would race with
 * fixture-seeded state).
 */

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const ELECTRON_ROOT = path.resolve(__dirname, "..", "..");
const PYTHON_PACKAGE_DIR = path.resolve(ELECTRON_ROOT, "..", "pdv-python");
// Persistent matplotlib font cache shared across E2E runs. Without this, every
// fresh temp HOME forces matplotlib to rebuild its font cache (~15-20s), which
// pushes pdv.bootstrap past the 15s readyTimeoutMs in kernel-session.ts.
const MPL_CACHE_DIR = path.join(ELECTRON_ROOT, "e2e", ".fixtures-cache", "matplotlib");

export interface LaunchOptions {
  /** Override Python interpreter path. Defaults to `process.env.PYTHON_PATH`. */
  pythonPath?: string;
  /** Pre-seed additional preferences.json keys (merged on top of the defaults). */
  preferences?: Record<string, unknown>;
  /** Extra env vars merged into the launched Electron process. */
  env?: Record<string, string>;
  /**
   * Hook fired after the temp HOME and `<HOME>/.PDV/preferences.json` are
   * created but before Electron is spawned. Use this to seed orphan working
   * dirs, recent project lists pointing at fixtures on disk, etc.
   */
  onBeforeLaunch?: (homeDir: string) => Promise<void>;
}

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  /** Temp dir used as HOME for this app instance. */
  homeDir: string;
  /** Closes the Electron app and removes the temp HOME. */
  cleanup: () => Promise<void>;
}

function withPythonPath(): string {
  const existing = process.env.PYTHONPATH;
  return existing
    ? `${PYTHON_PACKAGE_DIR}${path.delimiter}${existing}`
    : PYTHON_PACKAGE_DIR;
}

async function seedPreferences(
  homeDir: string,
  pythonPath: string,
  extra: Record<string, unknown> | undefined,
): Promise<void> {
  const pdvDir = path.join(homeDir, ".PDV");
  await fs.mkdir(pdvDir, { recursive: true });
  // Mirror a real user preferences.json. We deliberately do NOT seed
  // pythonEditorCmd/juliaEditorCmd/fileManagerCmd: any code path that shells
  // out to the configured editor (e.g. "Open in editor" on a script node)
  // would otherwise launch a real VS Code window during the test, which then
  // outlives the Electron app being torn down.
  const prefs = {
    pythonPath,
    showPrivateVariables: false,
    showModuleVariables: false,
    showCallableVariables: false,
    autoRefreshNamespace: false,
    autoSaveIntervalSeconds: 300,
    ...(extra ?? {}),
  };
  await fs.writeFile(
    path.join(pdvDir, "preferences.json"),
    JSON.stringify(prefs, null, 2),
    "utf8",
  );
}

/**
 * Launch the prod Electron bundle for an E2E test.
 *
 * Asserts that `dist/main/bootstrap.js` and `renderer/dist/index.html` exist;
 * if not, the caller should run `npm run build:e2e` first (the global setup
 * hook does this for the suite).
 */
export async function launchPDV(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const pythonPath = opts.pythonPath ?? process.env.PYTHON_PATH;
  if (!pythonPath) {
    throw new Error(
      "launchPDV: PYTHON_PATH env var must point at a Python with pdv installed " +
        "(e.g. `PYTHON_PATH=/path/to/python npm run test:e2e`).",
    );
  }

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-e2e-home-"));
  await seedPreferences(homeDir, pythonPath, opts.preferences);
  await fs.mkdir(MPL_CACHE_DIR, { recursive: true });
  if (opts.onBeforeLaunch) {
    await opts.onBeforeLaunch(homeDir);
  }

  // Pass "." rather than "dist/main/bootstrap.js" so Electron resolves
  // package.json (and `app.getVersion()`) from the project root. Passing the
  // bundled script path directly causes app.getVersion() to fall back to the
  // Electron framework version, which makes pdv-python's version check fail.
  // --no-sandbox is required on Linux CI runners where chromium's sandbox
  // (user namespaces / seccomp) isn't available; harmless elsewhere.
  const launchArgs = ["."];
  if (process.platform === "linux" && process.env.CI) {
    launchArgs.push("--no-sandbox");
  }
  const app = await electron.launch({
    args: launchArgs,
    cwd: ELECTRON_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PYTHON_PATH: pythonPath,
      // Pin matplotlib's cache to a persistent dir so the kernel doesn't
      // rebuild fonts (~15s) every test run and blow the bootstrap timeout.
      MPLCONFIGDIR: MPL_CACHE_DIR,
      PDV_E2E: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ...(opts.env ?? {}),
    },
  });

  // Always surface the main-process stderr so kernel/bootstrap failures aren't
  // silenced inside the spawned Electron process. Stdout is gated behind
  // PDV_E2E_VERBOSE because it is high-volume during normal kernel ops.
  app.process().stderr?.on("data", (b: Buffer) => process.stderr.write(`[main:err] ${b}`));
  if (process.env.PDV_E2E_VERBOSE === "1") {
    app.process().stdout?.on("data", (b: Buffer) => process.stdout.write(`[main] ${b}`));
  }

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const cleanup = async (): Promise<void> => {
    try {
      await app.close();
    } catch {
      // Already closed (test may have done it explicitly).
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  };

  return { app, window, homeDir, cleanup };
}
