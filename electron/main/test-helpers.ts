/**
 * test-helpers.ts — Shared mock factories for main-process IPC tests.
 *
 * Each `register*IpcHandlers()` function takes a bag of dependencies
 * (KernelManager, CommRouter, ProjectManager, ConfigStore, BrowserWindow,
 * etc.). Per-test instantiation of these mocks was duplicated across
 * `index.test.ts` and now lives here so new `ipc-register-*.test.ts` files
 * can build the same harness without copy-paste.
 *
 * Note on `vi.hoisted` and `vi.mock("electron")`: vitest hoists those calls
 * to the very top of the test file before regular imports run. So each test
 * file must declare its own `vi.hoisted(...)` block defining the captured
 * `ipcMain.handle`/`removeHandler` mocks. This file exposes
 * {@link createIpcRegistry} which can be called *inside* such a hoisted
 * block — the implementation references only `vi.fn` and `Map`, both
 * available at hoist time without imports.
 */

import { vi } from "vitest";
import type { BrowserWindow } from "electron";

import {
  PDVMessageType,
  setAppVersion,
  type PDVMessage,
} from "./pdv-protocol";

// Set the app version once at module load so makeOkResponse and other helpers
// don't trigger the "getAppVersion() called before setAppVersion()" warning.
// Tests that care about the actual version should call setAppVersion() in
// their own beforeEach.
setAppVersion("0.0.0-test");
import type { KernelInfo, KernelManager } from "./kernel-manager";
import type { CommRouter } from "./comm-router";
import type { ProjectManager } from "./project-manager";
import type { ConfigStore } from "./config";
import type { ModuleManager } from "./module-manager";
import type { ModuleWindowManager } from "./module-window-manager";
import type { GuiEditorWindowManager } from "./gui-editor-window-manager";
import type { GuiViewerWindowManager } from "./gui-viewer-window-manager";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

export type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface IpcRegistry {
  handlers: Map<string, InvokeHandler>;
  ipcHandle: ReturnType<typeof vi.fn>;
  ipcRemoveHandler: ReturnType<typeof vi.fn>;
  /** Throw if the handler is not registered, so test helpers can assume non-null. */
  getHandler: (channel: string) => InvokeHandler;
  /** Convenience: invoke the handler with a synthetic event-of-`{}`. */
  invoke: (channel: string, ...args: unknown[]) => unknown;
  /** Reset captured handlers (call from `beforeEach`). */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// IPC registry — mock the `ipcMain.handle()` capture pattern.
// ---------------------------------------------------------------------------

/**
 * Build an {@link IpcRegistry}. Call inside a `vi.hoisted(...)` block so the
 * registry is constructed before `vi.mock("electron", ...)` evaluates.
 */
export function createIpcRegistry(): IpcRegistry {
  const handlers = new Map<string, InvokeHandler>();
  const ipcHandle = vi.fn((channel: string, handler: InvokeHandler) => {
    handlers.set(channel, handler);
  });
  const ipcRemoveHandler = vi.fn((channel: string) => {
    handlers.delete(channel);
  });
  return {
    handlers,
    ipcHandle,
    ipcRemoveHandler,
    getHandler(channel: string): InvokeHandler {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`IPC handler not registered: ${channel}`);
      }
      return handler;
    },
    invoke(channel: string, ...args: unknown[]): unknown {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`IPC handler not registered: ${channel}`);
      }
      return handler({}, ...args);
    },
    reset() {
      handlers.clear();
      ipcHandle.mockClear();
      ipcRemoveHandler.mockClear();
    },
  };
}

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

export function makeKernelInfo(overrides: Partial<KernelInfo> = {}): KernelInfo {
  return {
    id: "kernel-1",
    name: "python3",
    language: "python",
    status: "idle",
    ...overrides,
  };
}

/**
 * Build a successful `PDVMessage` envelope with the given payload. Mirrors
 * what comm-router's `request()` resolves with.
 */
export function makeOkResponse(payload: Record<string, unknown> = {}): PDVMessage {
  return {
    pdv_version: "0.0.0-test",
    msg_id: "msg-test",
    in_reply_to: "req-test",
    type: "response",
    status: "ok",
    payload,
  };
}

/**
 * Build an error `PDVMessage` envelope.
 */
export function makeErrorResponse(code: string, message: string): PDVMessage {
  return {
    pdv_version: "0.0.0-test",
    msg_id: "msg-test",
    in_reply_to: "req-test",
    type: "response",
    status: "error",
    payload: { code, message },
  };
}

// ---------------------------------------------------------------------------
// BrowserWindow mock
// ---------------------------------------------------------------------------

export interface BrowserWindowMock {
  win: BrowserWindow;
  webContentsSend: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
}

export function createBrowserWindowMock(): BrowserWindowMock {
  const webContentsSend = vi.fn();
  const isDestroyed = vi.fn(() => false);
  const win = {
    webContents: { send: webContentsSend },
    on: vi.fn(),
    isDestroyed,
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  } as unknown as BrowserWindow;
  return { win, webContentsSend, isDestroyed };
}

// ---------------------------------------------------------------------------
// KernelManager mock
// ---------------------------------------------------------------------------

export function createKernelManagerMock(
  overrides: Partial<KernelManager> = {},
): KernelManager {
  return {
    list: vi.fn(() => []),
    start: vi.fn(async () => makeKernelInfo()),
    stop: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ result: undefined })),
    interrupt: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({
      matches: [],
      cursor_start: 0,
      cursor_end: 0,
    })),
    inspect: vi.fn(async () => ({ found: false })),
    ping: vi.fn(async () => undefined),
    getKernel: vi.fn(() => makeKernelInfo()),
    getQueryPort: vi.fn(() => 12345),
    shutdownAll: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
    ...overrides,
  } as unknown as KernelManager;
}

// ---------------------------------------------------------------------------
// CommRouter mock — also tracks push subscriptions for forwarding tests.
// ---------------------------------------------------------------------------

export interface CommRouterMock {
  router: CommRouter;
  request: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  /** Manually trigger a push notification by message type (for forwarding tests). */
  emitPush: (type: string, message?: PDVMessage) => void;
}

export function createCommRouterMock(
  overrides: Partial<CommRouter> = {},
): CommRouterMock {
  const pushHandlers = new Map<string, Array<(message: PDVMessage) => void>>();
  const request = vi.fn(async () => makeOkResponse());
  const attach = vi.fn();
  const detach = vi.fn();
  const onPush = vi.fn((type: string, handler: (message: PDVMessage) => void) => {
    const existing = pushHandlers.get(type) ?? [];
    existing.push(handler);
    pushHandlers.set(type, existing);
    if (type === PDVMessageType.READY) {
      handler(makeOkResponse());
    }
  });
  const offPush = vi.fn(
    (type: string, handler: (message: PDVMessage) => void) => {
      const existing = pushHandlers.get(type) ?? [];
      pushHandlers.set(
        type,
        existing.filter((entry) => entry !== handler),
      );
    },
  );
  const router = {
    request,
    onPush,
    offPush,
    attach,
    detach,
    ...overrides,
  } as unknown as CommRouter;

  return {
    router,
    request,
    attach,
    detach,
    emitPush(type: string, message: PDVMessage = makeOkResponse()): void {
      const handlers = pushHandlers.get(type) ?? [];
      for (const h of handlers) h(message);
    },
  };
}

// ---------------------------------------------------------------------------
// ProjectManager mock
// ---------------------------------------------------------------------------

export function createProjectManagerMock(
  overrides: Partial<ProjectManager> = {},
): ProjectManager {
  return {
    save: vi.fn(async () => ({
      checksum: "abc123",
      nodeCount: 0,
      moduleOwnedFiles: [],
      moduleManifests: [],
      missingFiles: [],
    })),
    load: vi.fn(async () => ({
      codeCells: null,
      postLoadChecksum: null,
    })),
    createWorkingDir: vi.fn(async () => "/tmp/pdv-test"),
    deleteWorkingDir: vi.fn(async () => undefined),
    clearCachedKernelResults: vi.fn(),
    startAutosaveTimer: vi.fn(),
    stopAutosaveTimer: vi.fn(),
    resetAutosaveTimer: vi.fn(),
    markAutosaveCacheDirty: vi.fn(),
    setAutosavePending: vi.fn(),
    consumeAutosavePending: vi.fn(() => false),
    autosave: vi.fn(async () => null),
    runWithSaveLock: vi.fn(<T,>(fn: () => Promise<T>) => fn()),
    ...overrides,
  } as unknown as ProjectManager;
}

// ---------------------------------------------------------------------------
// ConfigStore mock
// ---------------------------------------------------------------------------

export interface ConfigStoreMock<T extends Record<string, unknown>> {
  store: ConfigStore;
  state: T;
  getAll: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

/**
 * Build a ConfigStore mock backed by an in-memory state object that tests can
 * inspect and mutate directly. The default state is the bare minimum to
 * satisfy `PDVConfig` for current tests; tests requiring richer config can
 * pass an initial state.
 */
export function createConfigStoreMock<T extends Record<string, unknown>>(
  initial: T,
): ConfigStoreMock<T> {
  const state = { ...initial };
  const getAll = vi.fn(() => ({ ...state }));
  const set = vi.fn((key: string, value: unknown) => {
    (state as Record<string, unknown>)[key] = value;
  });
  return {
    store: { getAll, set } as unknown as ConfigStore,
    state,
    getAll,
    set,
  };
}

// ---------------------------------------------------------------------------
// ModuleManager mock — covers all methods consumed by ipc-register files.
// ---------------------------------------------------------------------------

export function createModuleManagerMock(
  overrides: Partial<ModuleManager> = {},
): ModuleManager {
  return {
    listInstalled: vi.fn(async () => []),
    install: vi.fn(async () => ({
      success: true,
      status: "installed",
    })),
    checkUpdates: vi.fn(async (moduleId: string) => ({
      moduleId,
      status: "not_implemented",
      message: "Not implemented",
    })),
    evaluateHealth: vi.fn(async () => []),
    resolveActionScripts: vi.fn(async () => []),
    getModuleInputs: vi.fn(async () => []),
    getModuleGuiInfo: vi.fn(async () => ({ hasGui: false })),
    getModuleInstallPath: vi.fn(async () => null),
    getGlobalStorePath: vi.fn(
      (moduleId: string) => `/tmp/pdv-global/modules/packages/${moduleId}`,
    ),
    registerInGlobalStore: vi.fn(async (moduleDir: string) => ({
      id: "mod",
      name: "Mod",
      version: "0.1.0",
      source: { type: "local" as const, location: moduleDir },
      installPath: moduleDir,
    })),
    getModuleSetupInfo: vi.fn(async () => ({})),
    isV4Module: vi.fn(async () => true),
    readModuleIndex: vi.fn(async () => []),
    getModuleDependencies: vi.fn(async () => []),
    resolveModuleDir: vi.fn(async () => null),
    uninstall: vi.fn(async () => ({ success: true })),
    update: vi.fn(async () => ({ success: true, status: "installed" })),
    ...overrides,
  } as unknown as ModuleManager;
}

// ---------------------------------------------------------------------------
// Window-manager mocks (for ipc-register-module-windows / -gui-editor)
// ---------------------------------------------------------------------------

export function createModuleWindowManagerMock(
  overrides: Partial<ModuleWindowManager> = {},
): ModuleWindowManager {
  return {
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => true),
    getContextForSender: vi.fn(() => null),
    ...overrides,
  } as unknown as ModuleWindowManager;
}

export function createGuiEditorWindowManagerMock(
  overrides: Partial<GuiEditorWindowManager> = {},
): GuiEditorWindowManager {
  return {
    open: vi.fn(async () => undefined),
    getContextForSender: vi.fn(() => null),
    ...overrides,
  } as unknown as GuiEditorWindowManager;
}

export function createGuiViewerWindowManagerMock(
  overrides: Partial<GuiViewerWindowManager> = {},
): GuiViewerWindowManager {
  return {
    open: vi.fn(async () => undefined),
    getContextForSender: vi.fn(() => null),
    ...overrides,
  } as unknown as GuiViewerWindowManager;
}
