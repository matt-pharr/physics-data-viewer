import { vi, type MockedFunction } from "vitest";
import type { PDVApi } from "../types/pdv";

/**
 * Helper that wraps `vi.fn()` and casts it to `MockedFunction<T>`. Because
 * `MockedFunction<T> extends T`, the resulting value is assignable to slots
 * typed as `T` inside the `satisfies PDVApi` check below. Tests still get the
 * full mock surface (`.mockResolvedValue`, `.mock.calls`, etc.).
 */
function stub<T extends (...args: never[]) => unknown>(
  impl?: T,
): MockedFunction<T> {
  return vi.fn((impl ?? (() => undefined)) as T) as MockedFunction<T>;
}

const noopUnsubscribe = (): void => {};
/**
 * Stub for `on*` subscription methods, which take a callback and return an
 * unsubscribe function. Defaults to a no-op unsubscribe; tests that need to
 * exercise the callback should override the method per-test and call the
 * captured callback themselves.
 */
function subStub<T extends (...args: never[]) => () => void>(): MockedFunction<T> {
  return vi.fn(() => noopUnsubscribe) as unknown as MockedFunction<T>;
}

/**
 * Build the default mock object once, then `satisfies PDVApi` to lock the
 * shape. If `preload.ts` adds a method or renames an existing one, this block
 * fails to compile — which is the entire point of typed mocks.
 *
 * Each method defaults to `vi.fn()` returning `undefined`. Tests should
 * override what they care about via the `overrides` parameter of
 * `createPdvMock` / `installPdvMock`.
 */
function buildBase() {
  return {
    kernels: {
      list: stub<PDVApi["kernels"]["list"]>(async () => []),
      start: stub<PDVApi["kernels"]["start"]>(),
      stop: stub<PDVApi["kernels"]["stop"]>(async () => true),
      execute: stub<PDVApi["kernels"]["execute"]>(),
      interrupt: stub<PDVApi["kernels"]["interrupt"]>(async () => true),
      restart: stub<PDVApi["kernels"]["restart"]>(),
      complete: stub<PDVApi["kernels"]["complete"]>(async () => ({
        matches: [],
        cursor_start: 0,
        cursor_end: 0,
      })),
      inspect: stub<PDVApi["kernels"]["inspect"]>(async () => ({ found: false })),
      validate: stub<PDVApi["kernels"]["validate"]>(async () => ({ valid: true })),
      onOutput: subStub<PDVApi["kernels"]["onOutput"]>(),
      onExecuteBegin: subStub<PDVApi["kernels"]["onExecuteBegin"]>(),
      onExecuteFinish: subStub<PDVApi["kernels"]["onExecuteFinish"]>(),
      onKernelCrashed: subStub<PDVApi["kernels"]["onKernelCrashed"]>(),
      onReconnected: subStub<PDVApi["kernels"]["onReconnected"]>(),
      onMemory: subStub<PDVApi["kernels"]["onMemory"]>(),
    },
    tree: {
      list: stub<PDVApi["tree"]["list"]>(async () => []),
      get: stub<PDVApi["tree"]["get"]>(async () => ({})),
      createScript: stub<PDVApi["tree"]["createScript"]>(async () => ({ success: true })),
      createNote: stub<PDVApi["tree"]["createNote"]>(async () => ({ success: true })),
      createGui: stub<PDVApi["tree"]["createGui"]>(async () => ({ success: true })),
      createLib: stub<PDVApi["tree"]["createLib"]>(async () => ({ success: true })),
      createNode: stub<PDVApi["tree"]["createNode"]>(async () => ({ success: true })),
      rename: stub<PDVApi["tree"]["rename"]>(async () => ({ success: true })),
      move: stub<PDVApi["tree"]["move"]>(async () => ({ success: true })),
      duplicate: stub<PDVApi["tree"]["duplicate"]>(async () => ({ success: true })),
      addFile: stub<PDVApi["tree"]["addFile"]>(async () => ({ success: true })),
      invokeHandler: stub<PDVApi["tree"]["invokeHandler"]>(async () => ({ success: true })),
      delete: stub<PDVApi["tree"]["delete"]>(async () => ({ success: true })),
      onChanged: subStub<PDVApi["tree"]["onChanged"]>(),
    },
    namespace: {
      query: stub<PDVApi["namespace"]["query"]>(async () => []),
      inspect: stub<PDVApi["namespace"]["inspect"]>(async () => ({
        children: [],
        truncated: false,
      })),
    },
    script: {
      run: stub<PDVApi["script"]["run"]>(),
      edit: stub<PDVApi["script"]["edit"]>(async () => ({ success: true })),
      getParams: stub<PDVApi["script"]["getParams"]>(async () => []),
    },
    note: {
      save: stub<PDVApi["note"]["save"]>(async () => ({ success: true })),
      read: stub<PDVApi["note"]["read"]>(async () => ({ success: true, content: "" })),
    },
    namelist: {
      read: stub<PDVApi["namelist"]["read"]>(),
      write: stub<PDVApi["namelist"]["write"]>(),
    },
    environment: {
      list: stub<PDVApi["environment"]["list"]>(async () => []),
      check: stub<PDVApi["environment"]["check"]>(async () => null),
      install: stub<PDVApi["environment"]["install"]>(),
      refresh: stub<PDVApi["environment"]["refresh"]>(async () => []),
      onInstallOutput: subStub<PDVApi["environment"]["onInstallOutput"]>(),
      onEnvActivity: subStub<PDVApi["environment"]["onEnvActivity"]>(),
    },
    modules: {
      listInstalled: stub<PDVApi["modules"]["listInstalled"]>(async () => []),
      install: stub<PDVApi["modules"]["install"]>(),
      checkUpdates: stub<PDVApi["modules"]["checkUpdates"]>(),
      importToProject: stub<PDVApi["modules"]["importToProject"]>(),
      listImported: stub<PDVApi["modules"]["listImported"]>(async () => []),
      saveSettings: stub<PDVApi["modules"]["saveSettings"]>(),
      runAction: stub<PDVApi["modules"]["runAction"]>(),
      removeImport: stub<PDVApi["modules"]["removeImport"]>(),
      uninstall: stub<PDVApi["modules"]["uninstall"]>(),
      update: stub<PDVApi["modules"]["update"]>(),
      createEmpty: stub<PDVApi["modules"]["createEmpty"]>(async () => ({ success: true })),
      updateMetadata: stub<PDVApi["modules"]["updateMetadata"]>(async () => ({ success: true })),
      exportFromProject: stub<PDVApi["modules"]["exportFromProject"]>(async () => ({ success: true })),
    },
    project: {
      save: stub<PDVApi["project"]["save"]>(),
      load: stub<PDVApi["project"]["load"]>(),
      new: stub<PDVApi["project"]["new"]>(async () => true),
      peekLanguages: stub<PDVApi["project"]["peekLanguages"]>(async () => ({})),
      peekManifest: stub<PDVApi["project"]["peekManifest"]>(),
      onLoaded: subStub<PDVApi["project"]["onLoaded"]>(),
      onReloading: subStub<PDVApi["project"]["onReloading"]>(),
    },
    progress: {
      onProgress: subStub<PDVApi["progress"]["onProgress"]>(),
    },
    config: {
      get: stub<PDVApi["config"]["get"]>(),
      set: stub<PDVApi["config"]["set"]>(),
    },
    mcp: {
      getStatus: stub<PDVApi["mcp"]["getStatus"]>(async () => ({
        running: false,
        host: "127.0.0.1",
        port: null,
        token: null,
        url: null,
        generation: 0,
        clientCount: 0,
      })),
      onClientStatus: subStub<PDVApi["mcp"]["onClientStatus"]>(),
    },
    window: {
      setBackgroundColor: stub<PDVApi["window"]["setBackgroundColor"]>(async () => undefined),
    },
    autosave: {
      run: stub<PDVApi["autosave"]["run"]>(async () => ({ saved: false })),
      clear: stub<PDVApi["autosave"]["clear"]>(async () => undefined),
      check: stub<PDVApi["autosave"]["check"]>(async () => ({ exists: false })),
      scanWorkingDirs: stub<PDVApi["autosave"]["scanWorkingDirs"]>(async () => []),
      recoverUnsaved: stub<PDVApi["autosave"]["recoverUnsaved"]>(),
      deleteOrphan: stub<PDVApi["autosave"]["deleteOrphan"]>(async () => undefined),
      onTrigger: subStub<PDVApi["autosave"]["onTrigger"]>(),
      onInFlightChange: subStub<PDVApi["autosave"]["onInFlightChange"]>(),
    },
    cells: {
      onRequest: subStub<PDVApi["cells"]["onRequest"]>(),
      onWrite: subStub<PDVApi["cells"]["onWrite"]>(),
      respond: stub<PDVApi["cells"]["respond"]>(async () => undefined),
    },
    about: {
      getVersion: stub<PDVApi["about"]["getVersion"]>(async () => "0.0.0-test"),
      openRepoPage: stub<PDVApi["about"]["openRepoPage"]>(async () => undefined),
      openIssuesPage: stub<PDVApi["about"]["openIssuesPage"]>(async () => undefined),
      openDocsPage: stub<PDVApi["about"]["openDocsPage"]>(async () => undefined),
    },
    updater: {
      checkForUpdates: stub<PDVApi["updater"]["checkForUpdates"]>(async () => undefined),
      downloadUpdate: stub<PDVApi["updater"]["downloadUpdate"]>(async () => undefined),
      installUpdate: stub<PDVApi["updater"]["installUpdate"]>(async () => undefined),
      openReleasesPage: stub<PDVApi["updater"]["openReleasesPage"]>(async () => undefined),
      getStatus: stub<PDVApi["updater"]["getStatus"]>(async () => null),
      onUpdateStatus: subStub<PDVApi["updater"]["onUpdateStatus"]>(),
    },
    themes: {
      get: stub<PDVApi["themes"]["get"]>(async () => []),
      save: stub<PDVApi["themes"]["save"]>(async () => true),
      openDir: stub<PDVApi["themes"]["openDir"]>(async () => ""),
    },
    codeCells: {
      load: stub<PDVApi["codeCells"]["load"]>(async () => null),
      save: stub<PDVApi["codeCells"]["save"]>(async () => true),
    },
    moduleWindows: {
      open: stub<PDVApi["moduleWindows"]["open"]>(),
      close: stub<PDVApi["moduleWindows"]["close"]>(async () => true),
      context: stub<PDVApi["moduleWindows"]["context"]>(async () => null),
      executeInMain: stub<PDVApi["moduleWindows"]["executeInMain"]>(async () => undefined),
      onExecuteRequest: subStub<PDVApi["moduleWindows"]["onExecuteRequest"]>(),
    },
    guiEditor: {
      open: stub<PDVApi["guiEditor"]["open"]>(),
      openViewer: stub<PDVApi["guiEditor"]["openViewer"]>(),
      context: stub<PDVApi["guiEditor"]["context"]>(async () => null),
      read: stub<PDVApi["guiEditor"]["read"]>(),
      save: stub<PDVApi["guiEditor"]["save"]>(),
    },
    files: {
      pickExecutable: stub<PDVApi["files"]["pickExecutable"]>(async () => null),
      pickFile: stub<PDVApi["files"]["pickFile"]>(async () => null),
      pickDirectory: stub<PDVApi["files"]["pickDirectory"]>(async () => null),
    },
    menu: {
      updateRecentProjects: stub<PDVApi["menu"]["updateRecentProjects"]>(async () => true),
      updateEnabled: stub<PDVApi["menu"]["updateEnabled"]>(async () => true),
      getModel: stub<PDVApi["menu"]["getModel"]>(async () => []),
      popup: stub<PDVApi["menu"]["popup"]>(async () => true),
      onAction: subStub<PDVApi["menu"]["onAction"]>(),
    },
    chrome: {
      getInfo: stub<PDVApi["chrome"]["getInfo"]>(),
      minimize: stub<PDVApi["chrome"]["minimize"]>(async () => true),
      toggleMaximize: stub<PDVApi["chrome"]["toggleMaximize"]>(async () => true),
      close: stub<PDVApi["chrome"]["close"]>(async () => true),
      onStateChanged: subStub<PDVApi["chrome"]["onStateChanged"]>(),
    },
    app: {
      confirmClose: stub<PDVApi["app"]["confirmClose"]>(async () => undefined),
      onRequestClose: subStub<PDVApi["app"]["onRequestClose"]>(),
      setDocumentEdited: stub<PDVApi["app"]["setDocumentEdited"]>(async () => undefined),
    },
  } satisfies PDVApi;
}

export type PdvMock = ReturnType<typeof buildBase>;

/**
 * Per-namespace overrides accept `Partial` of each namespace's method bag,
 * typed against the source `PDVApi` (not `PdvMock`) so callers can supply any
 * function whose signature is compatible with the API method — they don't need
 * to construct a `MockedFunction<...>` themselves.
 */
export type PdvMockOverrides = {
  [K in keyof PDVApi]?: Partial<PDVApi[K]>;
};

/**
 * Build a typed `window.pdv` mock. Every PDVApi method is stubbed with a
 * `MockedFunction` returning a sensible default. Pass overrides to swap in
 * test-specific implementations:
 *
 * ```ts
 * const pdv = createPdvMock({
 *   tree: { list: vi.fn(async () => myFixtureNodes) },
 * });
 * ```
 */
export function createPdvMock(overrides: PdvMockOverrides = {}): PdvMock {
  const base = buildBase();
  for (const namespace of Object.keys(overrides) as (keyof PdvMockOverrides)[]) {
    const override = overrides[namespace] as Record<string, unknown> | undefined;
    if (!override) continue;
    Object.assign(base[namespace] as Record<string, unknown>, override);
  }
  return base;
}

/**
 * Build a typed mock and install it as `window.pdv`. Returns the mock so
 * callers can assert on `.mock.calls` or swap in `mockResolvedValue` later.
 */
export function installPdvMock(overrides: PdvMockOverrides = {}): PdvMock {
  const mock = createPdvMock(overrides);
  Object.defineProperty(window, "pdv", {
    configurable: true,
    value: mock,
  });
  return mock;
}
