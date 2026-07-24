/**
 * index.ts — Shell-side IPC wiring for the main window.
 *
 * Registers the shell-owned invoke channels (`SHELL_CHANNELS` in `ipc.ts`:
 * window chrome, menus, native pickers, updater, themes, launchers, child
 * windows), wires the pdv-server core via `server/wire.ts` with
 * window-bound push/confirm closures, and mirrors every server-registered
 * channel onto `ipcMain` so the renderer's `window.pdv` API is served from
 * one process in single-process mode.
 *
 * This module does NOT own server session state (kernel/project/module
 * closures live in `server/wire.ts`), handler logic for server channels,
 * or channel-name constants (`ipc.ts`).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.1, §11.2, §11.3
 * server/wire.ts — pdv-server core assembly
 */

import { BrowserWindow, app, dialog } from "electron";
import * as path from "path";

import type { UpdateCheckStamp } from "./auto-updater";
import type { CommRouter } from "./comm-router";
import { ConfigStore } from "./config";
import { GuiEditorWindowManager } from "./gui-editor-window-manager";
import { GuiViewerWindowManager } from "./gui-viewer-window-manager";
import {
  BROADCAST_PUSH_CHANNELS,
  IPC,
  type McpStatus,
  type PDVConfig,
} from "./ipc";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import { registerGuiEditorIpcHandlers } from "./ipc-register-gui-editor";
import { registerLaunchersIpcHandlers } from "./ipc-register-launchers";
import { registerModuleWindowIpcHandlers } from "./ipc-register-module-windows";
import { handleIpcRaw, removeAllIpcHandlers } from "./ipc-registry";
import type { KernelManager } from "./kernel-manager";
import { ModuleWindowManager } from "./module-window-manager";
import { setAppVersion } from "./pdv-protocol";
import type { ProjectManager } from "./project-manager";
import type { QueryRouter } from "./query-router";
import type { ConfirmOptions } from "./server/confirm";
import {
  dispatchInvoke,
  listRegisteredInvokeChannels,
  type InvokeContext,
  type PushSender,
} from "./server/invoke-registry";
import { unwireServer, wireServer } from "./server/wire";

// ---------------------------------------------------------------------------
// Unified version — set once before any handler uses getAppVersion()
// ---------------------------------------------------------------------------
setAppVersion(app.getVersion());

// ---------------------------------------------------------------------------
// Public registration API
// ---------------------------------------------------------------------------

/**
 * Register every IPC channel the renderer's `window.pdv` API consumes:
 * shell channels directly on `ipcMain`, server channels via
 * `server/wire.ts` mirrored onto `ipcMain`.
 *
 * @param win - Main browser window used for push forwarding.
 * @param kernelManager - Kernel manager instance.
 * @param commRouter - Comm router bound to the active kernel.
 * @param queryRouter - Query router bound to the active kernel.
 * @param projectManager - Project manager dependency.
 * @param configStore - Config persistence dependency.
 * @param pdvDir - `~/.PDV` root for themes/state/module-store paths.
 * @param setAllowClose - Flips the close-guard flag in `app.ts`.
 * @returns The wire's `resetSessionState`, called on renderer reloads.
 */
export function registerIpcHandlers(
  win: BrowserWindow,
  kernelManager: KernelManager,
  commRouter: CommRouter,
  queryRouter: QueryRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore,
  pdvDir: string,
  setAllowClose: (allow: boolean) => void
): () => void {
  unregisterIpcHandlers();

  // Derive per-purpose sub-directories within ~/.PDV
  const themesDir = path.join(pdvDir, "themes");
  const stateDir  = path.join(pdvDir, "state");

  const preloadPath = path.join(__dirname, "..", "preload.js");
  const moduleWindowManager = new ModuleWindowManager(preloadPath);
  const guiEditorWindowManager = new GuiEditorWindowManager(preloadPath);
  const guiViewerWindowManager = new GuiViewerWindowManager(preloadPath);

  // Renderer-push sender shared by the whole server core: the one place
  // pushes meet the BrowserWindow. The destroyed-window guard lives here so
  // handler code never needs it, and broadcast channels fan out to child
  // windows here so the server emits each push exactly once.
  const push: PushSender = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
    if (BROADCAST_PUSH_CHANNELS.includes(channel)) {
      moduleWindowManager.broadcastToAll(channel, payload);
      guiEditorWindowManager.broadcastToAll(channel, payload);
      guiViewerWindowManager.broadcastToAll(channel, payload);
    }
  };

  // Native-confirmation closure injected into server-destined code that
  // needs a blocking user decision (module-export overwrite, MCP tree
  // deletion). See server/confirm.ts for the extracted-server plan.
  const confirm = async (options: ConfirmOptions): Promise<number> => {
    const result = win.isDestroyed()
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(win, options);
    return result.response;
  };

  // Assemble the pdv-server core. Every server channel lands in the
  // Electron-free invoke registry; the mirror loop below is the only point
  // where those handlers meet Electron.
  const wire = wireServer({
    push,
    confirm,
    pdvDir,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    configStore,
    closeChildWindows: () => {
      moduleWindowManager.closeAll();
      guiEditorWindowManager.closeAll();
      guiViewerWindowManager.closeAll();
    },
    startMcp: true,
  });

  // Mirror every server-registered channel onto ipcMain. dispatchInvoke
  // owns the error logging and normalization, so the unwrapped ipcMain
  // registration is used here — wrapping again via handleIpc would
  // double-log every failure.
  const invokeCtx: InvokeContext = { push };
  for (const channel of listRegisteredInvokeChannels()) {
    handleIpcRaw(channel, (_event, ...args) =>
      dispatchInvoke(channel, invokeCtx, args)
    );
  }

  // Shell-side async access to server state. In single-process mode this
  // dispatches into the in-process registry; once the server is extracted
  // these calls ride the transport instead. Shell code must not touch the
  // ConfigStore directly — it lives with the server.
  const serverInvoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
    dispatchInvoke(channel, invokeCtx, args);
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
    getLauncherContext: async () => wire.getLauncherContext(),
    getConfig: async () => (await serverInvoke(IPC.config.get)) as PDVConfig,
    getMcpStatus: async (): Promise<McpStatus | null> => wire.getMcpStatus(),
    resolveTreeFile: (treePath) => wire.resolveTreeFile(treePath),
  });

  return wire.resetSessionState;
}

/**
 * Unregister every IPC handler and subscription registered by
 * {@link registerIpcHandlers}: the shell's `ipcMain` handlers (including
 * the server mirror) and the server core's registry, listeners, and
 * per-kernel state.
 *
 * @returns Nothing.
 */
export function unregisterIpcHandlers(): void {
  removeAllIpcHandlers();
  unwireServer();
}
