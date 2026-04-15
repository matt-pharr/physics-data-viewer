/**
 * auto-updater.ts — App auto-update via electron-updater.
 *
 * Checks GitHub Releases for newer versions, downloads updates, and
 * applies them on restart. Uses the `latest-mac.yml` / `latest-linux.yml`
 * manifests that electron-builder publishes alongside release artifacts.
 *
 * Supported platforms:
 * - macOS: full auto-update (download + replace + restart)
 * - Linux AppImage: full auto-update
 * - Linux deb/snap: notification only — user must download manually
 *
 * In development (`!app.isPackaged`), update checks are skipped to avoid
 * errors from the missing `app-update.yml` resource.
 *
 * See Also
 * --------
 * ipc-register-app-state.ts — registers the IPC handlers that call these functions
 * app.ts — calls initAutoUpdater() during window creation
 */

import { app, BrowserWindow, shell } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import { IPC } from "./ipc";
import type { ConfigStore } from "./config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Update status pushed to the renderer via `IPC.push.updateStatus`.
 */
export interface UpdateStatus {
  /** Current phase of the update lifecycle. */
  state:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  /** Version string of the available update (present when state is "available" or "downloaded"). */
  version?: string;
  /** Download progress percentage 0–100 (present when state is "downloading"). */
  progress?: number;
  /** Human-readable error message (present when state is "error"). */
  error?: string;
  /** GitHub Releases URL for platforms that cannot auto-update. */
  releaseUrl?: string;
  /** False when the platform cannot auto-update (deb/snap). */
  canAutoUpdate?: boolean;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const RELEASES_URL = "https://github.com/matt-pharr/physics-data-viewer/releases/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STARTUP_DELAY_MS = 10_000; // 10 seconds after window load

let mainWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the current platform supports in-place auto-update.
 *
 * macOS and Linux AppImage support auto-update. Linux deb/snap installs
 * are managed by the system package manager and cannot be updated in place.
 */
function canAutoUpdate(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform === "linux" && !!process.env.APPIMAGE) return true;
  return false;
}

/**
 * Push an UpdateStatus object to the renderer.
 *
 * @param status - Status to send.
 */
function pushStatus(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.push.updateStatus, status);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the auto-updater and wire event handlers.
 *
 * Must be called once from `createWindow` in `app.ts` after the
 * BrowserWindow is created. Schedules a startup update check if more
 * than 24 hours have elapsed since the last check.
 *
 * @param win - The main BrowserWindow for push notifications.
 * @param configStore - Config store for persisting lastUpdateCheck timestamp.
 */
export function initAutoUpdater(win: BrowserWindow, configStore: ConfigStore): void {
  mainWindow = win;

  if (!app.isPackaged) {
    return;
  }

  // Do not download automatically — let the user confirm first.
  autoUpdater.autoDownload = false;
  // Install on quit so the next launch uses the new version.
  autoUpdater.autoInstallOnAppQuit = true;
  // Include prerelease tags (e.g. v0.0.11-alpha1) since the app is still in alpha.
  autoUpdater.allowPrerelease = true;

  // -- Event wiring ----------------------------------------------------------

  autoUpdater.on("checking-for-update", () => {
    pushStatus({ state: "checking" });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    const auto = canAutoUpdate();
    pushStatus({
      state: "available",
      version: info.version,
      canAutoUpdate: auto,
      releaseUrl: auto ? undefined : RELEASES_URL,
    });
  });

  autoUpdater.on("update-not-available", () => {
    pushStatus({ state: "not-available" });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    pushStatus({
      state: "downloading",
      progress: Math.round(progress.percent),
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    pushStatus({
      state: "downloaded",
      version: info.version,
    });
  });

  autoUpdater.on("error", (err: Error) => {
    pushStatus({
      state: "error",
      error: err.message,
    });
  });

  // -- Startup check ---------------------------------------------------------

  const lastCheck = configStore.get("lastUpdateCheck");
  const now = Date.now();
  if (!lastCheck || now - lastCheck > CHECK_INTERVAL_MS) {
    setTimeout(() => {
      void checkForUpdates(configStore);
    }, STARTUP_DELAY_MS);
  }
}

/**
 * Trigger an update check against GitHub Releases.
 *
 * Results arrive asynchronously via autoUpdater events, which push
 * status to the renderer.
 *
 * @param configStore - Optional config store to record the check timestamp.
 */
export async function checkForUpdates(configStore?: ConfigStore): Promise<void> {
  if (!app.isPackaged) {
    pushStatus({ state: "not-available" });
    return;
  }
  if (configStore) {
    configStore.set("lastUpdateCheck", Date.now());
  }
  await autoUpdater.checkForUpdates();
}

/**
 * Download the available update.
 *
 * Call after the renderer confirms the user wants to proceed.
 * Progress is reported via the `download-progress` event.
 */
export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

/**
 * Quit and install the downloaded update.
 *
 * The app will close and relaunch with the new version.
 */
export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}

/**
 * Open the GitHub Releases page in the system browser.
 *
 * Used on platforms that cannot auto-update (deb/snap).
 */
export async function openReleasesPage(): Promise<void> {
  await shell.openExternal(RELEASES_URL);
}
