/**
 * index.ts — Electron main process entry point.
 *
 * Bootstraps the entire application in order:
 *
 * 1. Wait for ``app.whenReady()``.
 * 2. Create the ConfigStore.
 * 3. Detect the Python environment (EnvironmentDetector).
 * 4. Create the working directory (temp dir).
 * 5. Start the KernelManager (spawns kernel, waits for pdv.ready → pdv.init).
 * 6. Construct ProjectManager.
 * 7. Create the BrowserWindow (createWindow).
 * 8. Wire app events (wireAppEvents).
 * 9. On close: shutdown kernel, delete working dir.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §4.1 (startup sequence), §6 (working directory lifecycle)
 */

import { app } from "electron";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

import { ConfigStore } from "./config";
import { EnvironmentDetector } from "./environment-detector";
import { KernelManager } from "./kernel-manager";
import { ProjectManager } from "./project-manager";
import { createWindow, wireAppEvents } from "./app";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // TODO: implement in Step 5
  throw new Error("main() not yet implemented");
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.whenReady().then(main).catch((err) => {
  console.error("[PDV] Fatal startup error:", err);
  app.exit(1);
});
