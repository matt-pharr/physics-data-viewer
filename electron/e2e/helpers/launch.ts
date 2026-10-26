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
// Persistent matplotlib font cache shared across E2E runs. Without this, every
// fresh temp HOME forces matplotlib to rebuild its font cache (~15-20s), which
// pushes pdv.bootstrap past the 15s readyTimeoutMs in kernel-session.ts.
const MPL_CACHE_DIR = path.join(ELECTRON_ROOT, "e2e", ".fixtures-cache", "matplotlib");
// Persistent uv package cache shared across E2E runs. uv derives its default
// cache dir from $HOME, so the per-launch temp HOME would otherwise start
// every app instance cold and re-download all uv-project dependencies —
// slow everywhere, and flaky on poor networks. Only the download cache is
// shared; HOME isolation (preferences, venvs, project state) is unaffected.
const UV_CACHE_DIR = path.join(ELECTRON_ROOT, "e2e", ".fixtures-cache", "uv");

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


/**
 * Kill any pdv-server session daemon this launch created under its temp
 * HOME. Daemons are DESIGNED to outlive the app (session survival is the
 * feature), and the idle cap can never reap them here: idle shutdown
 * autosaves first, the autosave target lives in this temp HOME — deleted
 * by cleanup — and a failed autosave blocks shutdown by design. Without
 * this, every remote spec leaks an immortal daemon + kernel pair on the
 * dev machine (observed: eleven pairs, the oldest eleven days).
 *
 * The daemon is a setsid group leader and its kernels share its process
 * group, so signalling the negative pid reaps the whole family at once.
 */
async function reapSessionDaemons(homeDir: string): Promise<void> {
  // Layout owned by main/server/session-paths.ts (REMOTE_ROOT + run/sessions).
  // If that layout ever moves, the canary below makes this reap fail loudly
  // in the test log instead of silently regressing back to leaked daemons.
  const sessionsDir = path.join(homeDir, ".pdv-server", "run", "sessions");
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    try {
      await fs.access(path.join(homeDir, ".pdv-server"));
      console.error(
        `[e2e] ${homeDir}/.pdv-server exists but run/sessions does not — ` +
          `has the session-paths layout moved? Daemon reap skipped.`,
      );
    } catch {
      // No daemon ever started under this HOME — the common local-spec case.
    }
    return;
  }
  for (const entry of entries) {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(sessionsDir, entry, "session.json"), "utf8"),
      ) as { pid?: number };
      if (typeof meta.pid !== "number" || !Number.isInteger(meta.pid) || meta.pid <= 1) {
        continue;
      }
      try {
        // Liveness probe first: signalling a recycled pgid would hit an
        // unrelated process group. kill(pid, 0) narrows the window to
        // genuinely-alive daemons recorded seconds ago by this launch.
        process.kill(meta.pid, 0);
      } catch {
        continue; // Daemon already exited.
      }
      try {
        process.kill(-meta.pid, "SIGTERM");
      } catch {
        continue; // Already gone (or a platform without process groups).
      }
      // Brief grace, then make sure: the graceful stop can park on the
      // (now doomed) autosave, and cleanup must stay bounded.
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        process.kill(-meta.pid, "SIGKILL");
      } catch {
        // Exited during the grace period — the good case.
      }
    } catch {
      // Unreadable metadata — nothing identifiable to reap for this entry.
    }
  }
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
  await fs.mkdir(UV_CACHE_DIR, { recursive: true });
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
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ...(opts.env ?? {}),
      // Critical E2E knobs go after `opts.env` so a caller-supplied env
      // object can't accidentally override them. PDV_E2E gates the orphan-
      // cleanup skip and the script.edit short-circuit; MPLCONFIGDIR points
      // matplotlib at the persistent font cache so we don't rebuild it
      // (~15s) every spec; UV_CACHE_DIR points uv at a persistent package
      // cache the temp HOME would otherwise leave cold.
      MPLCONFIGDIR: MPL_CACHE_DIR,
      UV_CACHE_DIR,
      PDV_E2E: "1",
    },
  });

  // Always surface the main-process stderr so kernel/bootstrap failures aren't
  // silenced inside the spawned Electron process. Stdout is gated behind
  // PDV_E2E_VERBOSE because it is high-volume during normal kernel ops.
  //
  // Filter known-harmless Chromium noise that fires when the launcher's
  // environment lacks the relevant system service:
  //   - `dbus/bus.cc:... Failed to connect to the bus` — no system message
  //     bus on Linux CI runners.
  //   - `gpu/...command_buffer_proxy_impl.cc ... ContextResult::kTransientFailure`
  //     — software GPU on headless runners flapping mid-init.
  // Both legs are anchored to the specific failure substring so we don't
  // swallow unrelated dbus/GPU errors that should surface. PDV_E2E_VERBOSE=1
  // disables the filter entirely if more debug context is needed.
  const stderrNoiseRe = /dbus\/bus\.cc.*Failed to connect to the bus.*Could not parse server address|command_buffer_proxy_impl\.cc.*ContextResult::kTransientFailure/;
  app.process().stderr?.on("data", (b: Buffer) => {
    const text = b.toString();
    if (process.env.PDV_E2E_VERBOSE !== "1") {
      const filtered = text
        .split("\n")
        .filter((line) => line === "" || !stderrNoiseRe.test(line))
        .join("\n");
      if (filtered.trim().length === 0) return;
      process.stderr.write(`[main:err] ${filtered}`);
      return;
    }
    process.stderr.write(`[main:err] ${text}`);
  });
  if (process.env.PDV_E2E_VERBOSE === "1") {
    app.process().stdout?.on("data", (b: Buffer) => process.stdout.write(`[main] ${b}`));
  }

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const cleanup = async (): Promise<void> => {
    // electronApp.close() must be bounded. On CI Linux, closing an app whose
    // session was REMOTE at close time hung forever: the quit tracer showed
    // the app reaching app.exit(0) 3ms after Playwright's inspector-evaluated
    // app.quit() — a remote disconnect is instant, unlike the ~1s local
    // server shutdown — and close()'s promise never resolved, eating the
    // whole test budget inside afterEach and failing specs whose bodies had
    // already passed. Race it against a timeout, record whether the Electron
    // process is genuinely still alive (an app that lingers after
    // app.exit(0) would be a real bug, not a Playwright close race), and
    // fall back to SIGKILL either way.
    const proc = app.process();
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        app.close().then(() => "closed" as const),
        new Promise<"timeout">((resolve) => {
          closeTimer = setTimeout(() => resolve("timeout"), 15_000);
        }),
      ]);
      if (outcome === "timeout") {
        console.error(
          `[e2e] electronApp.close() did not resolve within 15s; ` +
            `process exitCode=${String(proc.exitCode)} killed=${String(proc.killed)}; killing it`,
        );
        proc.kill("SIGKILL");
      }
    } catch {
      // Already closed (test may have done it explicitly).
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    // Before deleting the temp HOME (session.json — the pid record — lives
    // in it), reap any session daemon this launch spawned.
    await reapSessionDaemons(homeDir);
    // app.close() resolves before the OS has necessarily flushed every last
    // write the closing session made under HOME/.PDV (a final autosave, the
    // restart-reload's file copies). If one lands mid-walk, a plain recursive
    // rm throws ENOTEMPTY. maxRetries/retryDelay is Node's built-in handling
    // for exactly this class of transient rmdir race.
    await fs.rm(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };

  return { app, window, homeDir, cleanup };
}
