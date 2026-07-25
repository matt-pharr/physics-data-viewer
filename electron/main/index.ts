/**
 * index.ts — Shell-side IPC wiring for the main window.
 *
 * Registers the shell-owned invoke channels (`SHELL_CHANNELS` in `ipc.ts`:
 * window chrome, menus, native pickers, updater, themes, launchers, child
 * windows) and wires the per-window server bridge
 * (`shell/server-bridge.ts`), which forwards every `SERVER_CHANNELS`
 * invoke to the pdv-server child process and fans its pushes out to the
 * renderer windows.
 *
 * This module does NOT own server session state or handler logic for
 * server channels (those live in the pdv-server process — see
 * `server/wire.ts`), spawn the server (`shell/server-supervisor.ts`,
 * owned by `bootstrap.ts`), or define channel names (`ipc.ts`).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.1, §11.2, §11.4
 * shell/server-bridge.ts — server-channel forwarding and push fan-out
 */

import { BrowserWindow } from "electron";
import * as path from "path";

import type { UpdateCheckStamp } from "./auto-updater";
import { GuiEditorWindowManager } from "./gui-editor-window-manager";
import { GuiViewerWindowManager } from "./gui-viewer-window-manager";
import {
  INTERNAL_CHANNELS,
  IPC,
  type McpStatus,
  type PDVConfig,
} from "./ipc";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import type { LauncherContext } from "./ipc-register-launchers";
import { registerGuiEditorIpcHandlers } from "./ipc-register-gui-editor";
import { registerLaunchersIpcHandlers } from "./ipc-register-launchers";
import { registerModuleWindowIpcHandlers } from "./ipc-register-module-windows";
import { removeAllIpcHandlers } from "./ipc-registry";
import { ModuleWindowManager } from "./module-window-manager";
import { registerServerBridge } from "./shell/server-bridge";
import type { ServerHandle } from "./shell/server-supervisor";

// ---------------------------------------------------------------------------
// Public registration API
// ---------------------------------------------------------------------------

/**
 * Register every IPC channel the renderer's `window.pdv` API consumes:
 * shell channels directly on `ipcMain`, server channels forwarded to the
 * pdv-server process via the bridge.
 *
 * Starts from a clean server session (`pdv.rpc.sessionReset`) — a no-op on
 * a freshly started server, and exactly the old unwire + re-wire reset on
 * macOS window re-creation.
 *
 * @param win - Main browser window used for push forwarding.
 * @param server - Handle to the supervised pdv-server process.
 * @param pdvDir - `~/.PDV` root for themes/state paths.
 * @param setAllowClose - Flips the close-guard flag in `app.ts`.
 * @returns The light session-reset callback, called on renderer reloads.
 * @throws {Error} When the server is not running (session reset fails).
 */
export async function registerIpcHandlers(
  win: BrowserWindow,
  server: ServerHandle,
  pdvDir: string,
  setAllowClose: (allow: boolean) => void
): Promise<() => void> {
  unregisterIpcHandlers();

  // Derive per-purpose sub-directories within ~/.PDV
  const themesDir = path.join(pdvDir, "themes");
  const stateDir  = path.join(pdvDir, "state");

  const preloadPath = path.join(__dirname, "..", "preload.js");
  const moduleWindowManager = new ModuleWindowManager(preloadPath);
  const guiEditorWindowManager = new GuiEditorWindowManager(preloadPath);
  const guiViewerWindowManager = new GuiViewerWindowManager(preloadPath);

  registerServerBridge({
    server,
    win,
    childWindowManagers: [
      moduleWindowManager,
      guiEditorWindowManager,
      guiViewerWindowManager,
    ],
  });

  // Reset server session state before the renderer loads, so stale state
  // from a previous window cannot leak into the new one (parity with the
  // pre-extraction full re-wire on every registration).
  await server.sessionReset();

  // Shell-side async access to server state over the transport. Shell code
  // must not touch the ConfigStore directly — it lives with the server.
  const serverInvoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
    server.invoke(channel, args);
  const updateCheckStamp: UpdateCheckStamp = {
    get: async () =>
      ((await serverInvoke(IPC.config.get)) as PDVConfig).lastUpdateCheck,
    set: async () => {
      await serverInvoke(IPC.config.set, { lastUpdateCheck: Date.now() });
    },
  };

  registerAppStateIpcHandlers({
    win,
    themesDir,
    stateDir,
    setAllowClose,
    updateCheckStamp,
  });

  registerModuleWindowIpcHandlers({
    moduleWindowManager,
    mainWindow: win,
  });

  registerGuiEditorIpcHandlers({
    guiEditorWindowManager,
    guiViewerWindowManager,
  });

  registerLaunchersIpcHandlers({
    getLauncherContext: async () =>
      (await serverInvoke(INTERNAL_CHANNELS.launcherContext)) as LauncherContext,
    getConfig: async () => (await serverInvoke(IPC.config.get)) as PDVConfig,
    getMcpStatus: async () =>
      (await serverInvoke(IPC.mcp.getStatus)) as McpStatus,
    resolveTreeFile: async (treePath) =>
      (await serverInvoke(
        INTERNAL_CHANNELS.resolveTreeFile,
        treePath
      )) as string | null,
  });

  // Light session reset on renderer load/reload: clears in-session server
  // state (active project/kernel closures, child windows) but keeps
  // per-kernel state on disk.
  return () => {
    void serverInvoke(INTERNAL_CHANNELS.resetSessionState).catch(
      (err: unknown) => {
        console.error("[pdv] renderer-reload session reset failed:", err);
      }
    );
  };
}

/**
 * Unregister every ipcMain handler registered by
 * {@link registerIpcHandlers}: the shell channels and the server-bridge
 * forwarders. Server-side state is NOT touched here — the next
 * registration resets it via `pdv.rpc.sessionReset`.
 *
 * @returns Nothing.
 */
export function unregisterIpcHandlers(): void {
  removeAllIpcHandlers();
}
