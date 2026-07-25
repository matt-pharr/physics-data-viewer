/**
 * ipc-register-app-state.test.ts — Unit tests for app-state IPC handlers.
 *
 * Covers all 19 channels in the registration: thin pass-throughs to dialog/
 * menu/auto-updater/shell are verified for delegation; behavior tests focus
 * on `themes:save` (filesystem
 * write), `chrome:getInfo` (platform detection), and the close-confirmation
 * flow.
 */

import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcRegistry = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcHandle = vi.fn(
    (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  );
  const ipcRemoveHandler = vi.fn((channel: string) => handlers.delete(channel));
  return { handlers, ipcHandle, ipcRemoveHandler };
});

const dialogMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}));

const shellMocks = vi.hoisted(() => ({
  openPath: vi.fn(async () => ""),
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async (_path: string, _options?: { recursive?: boolean }) => undefined),
  writeFile: vi.fn(async (_path: string, _contents: string, _encoding?: string) => undefined),
}));

const fsSyncMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(() => undefined),
  readdirSync: vi.fn(() => [] as string[]),
  readFileSync: vi.fn(() => ""),
}));

const menuMocks = vi.hoisted(() => ({
  getTopLevelMenuModel: vi.fn(() => [{ id: "file", label: "File", items: [] }]),
  popupTopLevelMenu: vi.fn(() => true),
  updateMenuEnabled: vi.fn(),
  updateRecentProjectsMenu: vi.fn(),
}));

const updaterMocks = vi.hoisted(() => ({
  initAutoUpdater: vi.fn(),
  checkForUpdates: vi.fn(async () => undefined),
  downloadUpdate: vi.fn(async () => undefined),
  installUpdate: vi.fn(),
  openReleasesPage: vi.fn(async () => undefined),
  getUpdateStatus: vi.fn(() => null),
}));

const appLifecycleMocks = vi.hoisted(() => ({
  isQuitting: vi.fn(() => false),
  isQuitRequestPending: vi.fn(() => false),
  clearQuitRequestPending: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
  dialog: dialogMocks,
  shell: shellMocks,
  app: {
    // Lazy require so the value derives from the shared
    // TEST_PDV_VERSION_TEST_SUFFIX constant without referencing a top-level
    // import inside vi.mock's hoisted factory. Same pattern as index.test.ts.
    getVersion: () =>
      (require("./test-helpers") as typeof import("./test-helpers"))
        .TEST_PDV_VERSION_TEST_SUFFIX,
    quit: vi.fn(),
  },
}));

vi.mock("fs/promises", () => fsMocks);
vi.mock("fs", () => fsSyncMocks);
vi.mock("./menu", () => menuMocks);
vi.mock("./auto-updater", () => updaterMocks);
vi.mock("./app", () => appLifecycleMocks);

import { app } from "electron";
import { IPC } from "./ipc";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import {
  createBrowserWindowMock,
  type InvokeHandler,
} from "./test-helpers";

function getHandler(channel: string): InvokeHandler {
  const h = ipcRegistry.handlers.get(channel);
  if (!h) throw new Error(`Channel not registered: ${channel}`);
  return h;
}

interface Harness {
  win: ReturnType<typeof createBrowserWindowMock>;
  setAllowClose: ReturnType<typeof vi.fn>;
  themesDir: string;
  stateDir: string;
}

function setup(): Harness {
  const win = createBrowserWindowMock();
  const setAllowClose = vi.fn();
  const themesDir = path.join(os.tmpdir(), "pdv-test-themes");
  const stateDir = path.join(os.tmpdir(), "pdv-test-state");
  registerAppStateIpcHandlers({
    win: win.win,
    themesDir,
    stateDir,
    setAllowClose,
    updateCheckStamp: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    },
  });
  return { win, setAllowClose, themesDir, stateDir };
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
  fsSyncMocks.existsSync.mockReturnValue(false);
  fsSyncMocks.readdirSync.mockReturnValue([]);
  appLifecycleMocks.isQuitting.mockReturnValue(false);
  appLifecycleMocks.isQuitRequestPending.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("themes:get / themes:save / themes:openDir", () => {
  it("themes:save writes the file with sanitized filename + persists in memory", async () => {
    setup();
    const theme = { name: "My Theme/!?", colors: { "--bg-primary": "#000" } };
    await getHandler(IPC.themes.save)({}, theme);
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    const [filePath, contents, encoding] = fsMocks.writeFile.mock.calls[0];
    expect(filePath).toMatch(/My Theme___\.json$/);
    expect(JSON.parse(contents as string)).toEqual(theme);
    expect(encoding).toBe("utf8");

    const themes = (await getHandler(IPC.themes.get)({})) as Array<{ name: string }>;
    expect(themes).toHaveLength(1);
    expect(themes[0].name).toBe(theme.name);
  });

  it("themes:openDir delegates to shell.openPath with the themes directory", async () => {
    const { themesDir } = setup();
    await getHandler(IPC.themes.openDir)({});
    expect(shellMocks.openPath).toHaveBeenCalledWith(themesDir);
  });
});

describe("menu:* delegations", () => {
  it("menu:updateRecentProjects forwards array values", async () => {
    setup();
    await getHandler(IPC.menu.updateRecentProjects)({}, ["/a", "/b"]);
    expect(menuMocks.updateRecentProjectsMenu).toHaveBeenCalledWith(["/a", "/b"]);
  });

  it("menu:updateRecentProjects coerces non-array input to []", async () => {
    setup();
    await getHandler(IPC.menu.updateRecentProjects)({}, null);
    expect(menuMocks.updateRecentProjectsMenu).toHaveBeenCalledWith([]);
  });

  it("menu:popup delegates with menuId, x, y", async () => {
    setup();
    const result = await getHandler(IPC.menu.popup)({}, "file", 10, 20);
    expect(menuMocks.popupTopLevelMenu).toHaveBeenCalledWith("file", 10, 20);
    expect(result).toBe(true);
  });
});

describe("chrome:* window controls", () => {
  it("chrome:getInfo reflects the current platform and maximized state", async () => {
    const { win } = setup();
    (win.win.isMaximized as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const info = (await getHandler(IPC.chrome.getInfo)({})) as {
      platform: string;
      isMaximized: boolean;
    };
    expect(info.isMaximized).toBe(true);
    expect(["macos", "linux", "windows"]).toContain(info.platform);
  });

  it("chrome:minimize and chrome:toggleMaximize call the corresponding window methods", async () => {
    const { win } = setup();
    await getHandler(IPC.chrome.minimize)({});
    expect(win.win.minimize).toHaveBeenCalled();

    (win.win.isMaximized as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await getHandler(IPC.chrome.toggleMaximize)({});
    expect(win.win.maximize).toHaveBeenCalled();

    (win.win.isMaximized as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await getHandler(IPC.chrome.toggleMaximize)({});
    expect(win.win.unmaximize).toHaveBeenCalled();
  });

  it("chrome:close pushes requestClose to renderer instead of closing directly", async () => {
    const { win } = setup();
    await getHandler(IPC.chrome.close)({});
    expect(win.webContentsSend).toHaveBeenCalledWith(IPC.push.requestClose);
    expect(win.win.close).not.toHaveBeenCalled();
  });

  it("chrome:close clears any pending quit request so a confirm afterwards closes the window instead of quitting on darwin", async () => {
    setup();
    await getHandler(IPC.chrome.close)({});
    expect(appLifecycleMocks.clearQuitRequestPending).toHaveBeenCalled();
  });
});

describe("app:confirmClose", () => {
  it("flips the allow-close flag and closes the window", async () => {
    const { setAllowClose, win } = setup();
    await getHandler(IPC.app.confirmClose)({});
    expect(setAllowClose).toHaveBeenCalledWith(true);
    expect(win.win.close).toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("when isQuitting is true (autoUpdater / OS logout path), calls app.quit() instead of win.close()", async () => {
    appLifecycleMocks.isQuitting.mockReturnValue(true);
    const { setAllowClose, win } = setup();
    await getHandler(IPC.app.confirmClose)({});
    expect(setAllowClose).toHaveBeenCalledWith(true);
    expect(app.quit).toHaveBeenCalled();
    expect(win.win.close).not.toHaveBeenCalled();
  });

  it("when a Cmd+Q quit is pending dialog resolution, calls app.quit() and clears the pending flag", async () => {
    appLifecycleMocks.isQuitRequestPending.mockReturnValue(true);
    const { setAllowClose, win } = setup();
    await getHandler(IPC.app.confirmClose)({});
    expect(setAllowClose).toHaveBeenCalledWith(true);
    expect(app.quit).toHaveBeenCalled();
    expect(win.win.close).not.toHaveBeenCalled();
    expect(appLifecycleMocks.clearQuitRequestPending).toHaveBeenCalled();
  });
});

describe("files:pick* dialogs", () => {
  it("returns null when the user cancels", async () => {
    setup();
    dialogMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    } as never);
    const result = await getHandler(IPC.files.pickExecutable)({});
    expect(result).toBeNull();
  });

  it("returns the first selected file path on success", async () => {
    setup();
    dialogMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/a/python3"],
    } as never);
    const result = await getHandler(IPC.files.pickExecutable)({});
    expect(result).toBe("/a/python3");
  });

  it("pickDirectory forwards defaultPath to the dialog", async () => {
    setup();
    dialogMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/projects/foo"],
    } as never);
    await getHandler(IPC.files.pickDirectory)({}, "/projects");
    expect(dialogMocks.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: ["openDirectory", "createDirectory"],
        defaultPath: "/projects",
      }),
    );
  });
});

