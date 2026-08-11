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
import { INTERNAL_CHANNELS, IPC, type McpStatus } from "./ipc";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import type { LauncherContext } from "./ipc-register-launchers";
import { registerGuiEditorIpcHandlers } from "./ipc-register-gui-editor";
import { registerLaunchersIpcHandlers } from "./ipc-register-launchers";
import { registerRemoteIpcHandlers } from "./ipc-register-remote";
import { registerModuleWindowIpcHandlers } from "./ipc-register-module-windows";
import { removeAllIpcHandlers } from "./ipc-registry";
import { ModuleWindowManager } from "./module-window-manager";
import { RemoteHostStore } from "./remote/host-config";
import { RemoteServerHandle } from "./shell/remote-server";
import { readMergedConfig, registerConfigBridge } from "./shell/config-bridge";
import { SessionRouter } from "./shell/session-router";
import type { LocalConfigStore } from "./shell/local-config-store";
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
 * @param server - Handle to the session's pdv-server.
 * @param localConfig - This machine's half of the config (theme, launchers, …).
 * @param pdvDir - `~/.PDV` root for themes/state paths.
 * @param userDataDir - Electron `userData` root, for shell-owned runtime
 *   artifacts that must not live in the server-owned `~/.PDV`.
 * @param setAllowClose - Flips the close-guard flag in `app.ts`.
 * @param createLocalServer - Starts a fresh local pdv-server, used when a
 *   remote session ends or disconnects and the window returns to local mode.
 *   Omitted in builds/tests without session swapping.
 * @returns The light session-reset callback, called on renderer reloads.
 * @throws {Error} When the server is not running (session reset fails).
 */
export async function registerIpcHandlers(
  win: BrowserWindow,
  server: ServerHandle,
  localConfig: LocalConfigStore,
  pdvDir: string,
  userDataDir: string,
  setAllowClose: (allow: boolean) => void,
  createLocalServer?: () => Promise<ServerHandle>
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
  // Purely shell-owned, so this no longer costs a round trip to the server.
  const updateCheckStamp: UpdateCheckStamp = {
    get: async () => localConfig.getAll().lastUpdateCheck,
    set: async () => {
      localConfig.apply({ lastUpdateCheck: Date.now() });
    },
  };

  registerConfigBridge({ server, localConfig });

  registerAppStateIpcHandlers({
    win,
    themesDir,
    stateDir,
    setAllowClose,
    updateCheckStamp,
  });

  // Per-host settings (directories, launch config, X11 toggle, recorded
  // session node). Constructed per registration: a macOS window reopen
  // builds a fresh one, which simply re-reads the file.
  const hostStore = new RemoteHostStore(userDataDir);

  // Connection control only. Establishing an ssh connection and running a
  // session over it are separate steps: nothing here swaps the active
  // ServerHandle, so local mode is unaffected by its presence.
  registerRemoteIpcHandlers({
    win,
    controlDir: path.join(userDataDir, "ssh-control"),
    // Built by `npm run build:server-bundle`. Absent in a checkout that has
    // not built them, which simply skips the bootstrap.
    bundleDir: path.join(__dirname, "..", "remote-bundles"),
    // Per-host setup-script master copies (one `<host>.sh` per alias),
    // edited in Settings → Remote Hosts.
    setupScriptDir: path.join(userDataDir, "remote-setup"),
    hostStore,
    // Only a router can move the session; anything else (a bare handle in a
    // test) gets connection control without session swapping rather than a
    // menu item that fails when used.
    router: server instanceof SessionRouter ? server : undefined,
    createLocalServer,
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
    getConfig: async () => readMergedConfig(server, localConfig),
    getMcpStatus: async () =>
      (await serverInvoke(IPC.mcp.getStatus)) as McpStatus,
    resolveTreeFile: async (treePath) =>
      (await serverInvoke(
        INTERNAL_CHANNELS.resolveTreeFile,
        treePath
      )) as string | null,
    // Remote identity comes from the ROUTER'S ACTIVE HANDLE, never from
    // the per-window connection manager: handles outlive window
    // registrations (a macOS reopen builds a fresh manager with no
    // connection), and the manager can be connected to a DIFFERENT host
    // than the one serving the session (connect and startSession are
    // separate steps). The handle carries the session's own host/control,
    // and its connectionState gates ssh-carried launches — a session
    // mid-reconnect refuses them rather than falling back to spawning
    // against cluster paths locally.
    getRemoteContext: () => {
      const active = server instanceof SessionRouter ? server.active : null;
      if (!(active instanceof RemoteServerHandle)) return null;
      const target = active.launcherTarget;
      if (!target) return { host: "", control: null, hostNameOverride: null };
      const usable = active.connectionState === "connected";
      return {
        host: target.host,
        control: usable ? target.control : null,
        // Pin ssh-carried launches to the login node the session daemon
        // lives on — a round-robin alias would otherwise land the
        // terminal/editor beside a working dir it cannot see.
        hostNameOverride: hostStore.get(target.host).sessionNode ?? null,
      };
    },
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
