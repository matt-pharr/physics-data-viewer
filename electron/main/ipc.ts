/**
 * ipc.ts — IPC channels and shared TypeScript contracts.
 *
 * This module is the single source of truth for all renderer ↔ main IPC
 * channel names and the typed preload API surface (`window.pdv`).
 *
 * This file intentionally contains no runtime logic. Handler registration
 * lives in `index.ts`, and the preload bridge implementation lives in
 * `../preload.ts`.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.1, §11.2, §13.3
 * index.ts — runtime `ipcMain.handle(...)` registration
 * preload.ts — runtime `contextBridge.exposeInMainWorld(...)` wiring
 */

import type {
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelExecutionOrigin,
  KernelInfo,
  KernelSpec,
  ExecuteOutputChunk,
} from "./kernel-manager";
import type {
  NodeDescriptor,
  PDVProjectLoadedPayload,
  ScriptParameter as PDVScriptParameter,
  PDVTreeChangedPayload,
} from "./pdv-protocol";

/**
 * Re-export the wire-canonical {@link NodeDescriptor} so renderer-facing
 * type files (`renderer/src/types/pdv.d.ts`) can consume a single source
 * of truth via type-only imports.
 */
export type { NodeDescriptor } from "./pdv-protocol";
import type { PDVConfig } from "./config";
import type {
  EnvironmentInfo,
  EnvironmentInstallResult,
  InstallOutputChunk,
} from "./environment-detector";

export type { PDVConfig } from "./config";
import type { UpdateStatus } from "./auto-updater";
export type { UpdateStatus } from "./auto-updater";
export type { EnvironmentInfo, EnvironmentInstallResult, InstallOutputChunk } from "./environment-detector";

// ---------------------------------------------------------------------------
// IPC channel catalogue
// ---------------------------------------------------------------------------

/**
 * All renderer ↔ main IPC channel names.
 *
 * These constants are consumed by both:
 * - main process handlers (`ipcMain.handle`)
 * - preload bridge invoke/on wrappers (`ipcRenderer.invoke`, `ipcRenderer.on`)
 */
export const IPC = {
  /** Kernel lifecycle and execution channels. */
  kernels: {
    list: "kernels:list",
    start: "kernels:start",
    stop: "kernels:stop",
    execute: "kernels:execute",
    interrupt: "kernels:interrupt",
    restart: "kernels:restart",
    complete: "kernels:complete",
    inspect: "kernels:inspect",
    validate: "kernels:validate",
  },
  /** Tree browsing and script-node creation channels. */
  tree: {
    list: "tree:list",
    get: "tree:get",
    createScript: "tree:createScript",
    createNote: "tree:createNote",
    addFile: "tree:addFile",
    createGui: "tree:createGui",
    /**
     * Create a new PDVLib node (`.py` file) inside a module's `lib/`
     * subtree. Used by workflow B of #140 — only valid when the target
     * path is under a known module alias.
     */
    createLib: "tree:createLib",
    invokeHandler: "tree:invokeHandler",
    delete: "tree:delete",
  },
  /** Namespace inspection channels. */
  namespace: {
    query: "namespace:query",
    inspect: "namespace:inspect",
  },
  /** Script tooling channels. */
  script: {
    edit: "script:edit",
    run: "script:run",
    getParams: "script:getParams",
  },
  /** Markdown note channels. */
  note: {
    save: "note:save",
    read: "note:read",
  },
  /** Modules system channels. */
  modules: {
    listInstalled: "modules:listInstalled",
    install: "modules:install",
    checkUpdates: "modules:checkUpdates",
    importToProject: "modules:importToProject",
    listImported: "modules:listImported",
    saveSettings: "modules:saveSettings",
    runAction: "modules:runAction",
    removeImport: "modules:removeImport",
    uninstall: "modules:uninstall",
    update: "modules:update",
    /**
     * Create a brand-new empty PDVModule inside the active project
     * (workflow B of issue #140). Seeds the tree with a top-level
     * PDVModule and three conventional empty subtrees (scripts, lib,
     * plots) plus working-dir scaffolding. The user populates content
     * via the existing tree:create* handlers afterwards.
     */
    createEmpty: "modules:createEmpty",
    /** Patch mutable metadata fields (name, version, description). */
    updateMetadata: "modules:updateMetadata",
    /**
     * Publish the active-project copy of a module to the global store
     * at ``~/.PDV/modules/packages/<id>/`` so other projects can import
     * it. Used by workflow A (push edits back) and workflow B (publish
     * a newly-authored module). See plan §9 and the follow-up #182 for
     * the eventual "commit + push to GitHub upstream" flow.
     */
    exportFromProject: "modules:exportFromProject",
  },
  /** Namelist read/write channels. */
  namelist: {
    read: "namelist:read",
    write: "namelist:write",
  },
  /** Project lifecycle channels. */
  project: {
    save: "project:save",
    load: "project:load",
    new: "project:new",
    peekLanguages: "project:peekLanguages",
    peekManifest: "project:peekManifest",
  },
  /** App configuration channels. */
  config: {
    get: "config:get",
    set: "config:set",
  },
  /** App info channels. */
  about: {
    getVersion: "about:getVersion",
  },
  /** App auto-update channels. */
  updater: {
    checkForUpdates: "updater:checkForUpdates",
    downloadUpdate: "updater:downloadUpdate",
    installUpdate: "updater:installUpdate",
    openReleasesPage: "updater:openReleasesPage",
  },
  /** Theme persistence channels. */
  themes: {
    get: "themes:get",
    save: "themes:save",
    openDir: "themes:openDir",
  },
  /** Code-cell persistence channels. */
  codeCells: {
    load: "codeCells:load",
    save: "codeCells:save",
  },
  /** Main → renderer push channels forwarded from CommRouter push messages. */
  push: {
    treeChanged: "pdv.tree.changed",
    projectLoaded: "pdv.project.loaded",
    /**
     * Fires when the kernel subprocess exits unexpectedly. There is no
     * corresponding `pdv.kernel.crashed` wire message; the channel is
     * emitted by the main process from its kernel-crash handler in
     * `ipc-register-kernels.ts`. Renderers should treat receipt as an
     * unrecoverable session loss.
     */
    kernelCrashed: "pdv.kernel.crashed",
    menuAction: "menu:action",
    chromeStateChanged: "chrome:stateChanged",
    executeOutput: "pdv.execute.output",
    moduleExecuteRequest: "pdv.moduleWindow.executeRequest",
    /**
     * Main → renderer. Emitted by the kernel-restart handler in
     * `ipc-register-kernels.ts` to bracket the project re-load that follows
     * a restart. The kernel itself never sends a `pdv.project.reloading`
     * comm message; the channel name is namespaced for symmetry with the
     * other `pdv.*` push channels but the source is purely main-side.
     */
    projectReloading: "pdv.project.reloading",
    progress: "pdv.progress",
    installOutput: "pdv.environment.installOutput",
    updateStatus: "pdv.updater.status",
    requestClose: "pdv.app.requestClose",
  },
  /** App-level lifecycle channels (close confirmation, etc.). */
  app: {
    confirmClose: "app:confirmClose",
  },
  /** App menu synchronization channels. */
  menu: {
    updateRecentProjects: "menu:updateRecentProjects",
    updateEnabled: "menu:updateEnabled",
    getModel: "menu:getModel",
    popup: "menu:popup",
  },
  /** Window-chrome integration channels. */
  chrome: {
    getInfo: "chrome:getInfo",
    minimize: "chrome:minimize",
    toggleMaximize: "chrome:toggleMaximize",
    close: "chrome:close",
  },
  /** Module popup window channels. */
  moduleWindows: {
    open: "moduleWindows:open",
    close: "moduleWindows:close",
    context: "moduleWindows:context",
    executeInMain: "moduleWindows:executeInMain",
  },
  /** GUI editor popup window channels. */
  guiEditor: {
    open: "guiEditor:open",
    openViewer: "guiEditor:openViewer",
    context: "guiEditor:context",
    read: "guiEditor:read",
    save: "guiEditor:save",
  },
  /** Python environment discovery and installation channels. */
  environment: {
    list: "environment:list",
    check: "environment:check",
    install: "environment:install",
    refresh: "environment:refresh",
  },
  /** Native file/directory picker channels. */
  files: {
    pickExecutable: "files:pickExecutable",
    pickFile: "files:pickFile",
    pickDirectory: "files:pickDirectory",
  },
} as const;

// Re-export for preload and renderer use.
export type { ExecuteOutputChunk };

// ---------------------------------------------------------------------------
// Kernel request/response helper types
// ---------------------------------------------------------------------------

/**
 * Completion response shape for `kernels.complete`.
 */
export interface KernelCompleteResult {
  /** Completion candidate strings. */
  matches: string[];
  /** Inclusive start cursor index for replacement. */
  cursor_start: number;
  /** Exclusive end cursor index for replacement. */
  cursor_end: number;
  /** Optional kernel-provided metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Inspection response shape for `kernels.inspect`.
 */
export interface KernelInspectResult {
  /** True when documentation/inspection data was found for the symbol. */
  found: boolean;
  /** Rich mime-bundle style content keyed by mime type. */
  data?: Record<string, string>;
}

/**
 * Environment validation result used by `kernels.validate`.
 */
export interface KernelValidateResult {
  /** True when the selected executable/path appears usable. */
  valid: boolean;
  /** Optional user-facing error message when `valid` is false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Namespace types
// ---------------------------------------------------------------------------

/**
 * Options for namespace filtering in `namespace.query`.
 */
export interface NamespaceQueryOptions {
  /** If true, include underscore-prefixed names. */
  includePrivate?: boolean;
  /** If true, include imported module values. */
  includeModules?: boolean;
  /** If true, include callable values (functions/classes). */
  includeCallables?: boolean;
}

/** Serializable selector used to drill into a namespace value. */
export interface NamespaceAccessSegment {
  /** Access mode used to resolve the next child. */
  kind: "attr" | "index" | "key" | "column";
  /** Primitive selector value used by the kernel resolver. */
  value: string | number | boolean | null;
}

/** Target value for lazy namespace inspection. */
export interface NamespaceInspectTarget {
  /** Top-level namespace variable name. */
  rootName: string;
  /** Selector chain from the root variable to the current node. */
  path: NamespaceAccessSegment[];
}

/**
 * Descriptor for a single variable in the namespace panel.
 */
export interface NamespaceInspectorNode {
  /** Display name for this row within the namespace inspector. */
  name: string;
  /** Canonical inspector kind used for branching/rendering. */
  kind: string;
  /** Runtime type label (e.g., `int`, `DataFrame`, `ndarray`). */
  type: string;
  /** Optional module the value originates from. */
  module?: string;
  /** Optional shape for array-like values. */
  shape?: number[];
  /** Optional dtype for typed values. */
  dtype?: string;
  /** Optional length for sequence-like values. */
  length?: number;
  /** Optional byte-size estimate for sorting/display. */
  size?: number;
  /** Optional short UI preview string. */
  preview?: string;
  /** Whether this row can be expanded for child inspection. */
  hasChildren?: boolean;
  /** Known child count when cheap to determine. */
  childCount?: number;
  /** Selector chain from the root variable to this node. */
  path: NamespaceAccessSegment[];
  /** Full user-facing expression for copy/tooltip actions. */
  expression: string;
}

/**
 * Descriptor for a single top-level variable in the namespace panel.
 */
export type NamespaceVariable = NamespaceInspectorNode;

/** Response payload returned from `namespace.inspect`. */
export interface NamespaceInspectResult {
  /** Child rows for the inspected node. */
  children: NamespaceInspectorNode[];
  /** Whether child results were truncated by inspection limits. */
  truncated: boolean;
  /** Total child count before truncation when known. */
  totalChildren?: number;
}

// ---------------------------------------------------------------------------
// Tree and script types
// ---------------------------------------------------------------------------

/**
 * Script run() parameter descriptor surfaced in script node metadata.
 */
export type ScriptParameter = PDVScriptParameter;

/**
 * Tree node shape returned to the renderer.
 */
export type TreeNode = NodeDescriptor;

/**
 * Result returned by `tree.createScript`.
 */
export interface TreeCreateScriptResult {
  /** True when script creation and registration succeeded. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
  /** Absolute path to the created script file. */
  scriptPath?: string;
}

/**
 * Result returned by `tree.createNote`.
 */
export interface TreeCreateNoteResult {
  /** True when note creation and registration succeeded. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
  /** Absolute path to the created markdown file. */
  notePath?: string;
  /** Dot-path of the created tree node. */
  treePath?: string;
}

/**
 * Result returned by `tree.invokeHandler`.
 */
export interface HandlerInvokeResult {
  /** True when the handler was found and dispatched. */
  success: boolean;
  /** Optional error message when dispatch failed. */
  error?: string;
}

/**
 * Result returned by `tree.addFile`.
 */
export interface TreeAddFileResult {
  /** True when the file was copied and registered successfully. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
  /** Absolute path to the copied file in the kernel working directory. */
  workingDirPath?: string;
}

/**
 * Result returned by `namelist.read`.
 */
export interface NamelistReadResult {
  /** Parsed namelist groups keyed by group name. */
  groups: Record<string, Record<string, unknown>>;
  /** Comment hints keyed by group then key. */
  hints: Record<string, Record<string, string>>;
  /** Inferred value types keyed by group then key. */
  types: Record<string, Record<string, string>>;
  /** Detected file format. */
  format: "fortran" | "toml";
}

/**
 * Result returned by `namelist.write`.
 */
export interface NamelistWriteResult {
  /** True when the write operation succeeded. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
}

/**
 * Result returned by `script.edit`.
 */
export interface ScriptOperationResult {
  /** True when the operation succeeded. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
}

/**
 * Request payload for `script.run`.
 *
 * The main process uses the target kernel's language to build the
 * appropriate invocation string — no language-specific code belongs
 * in the renderer.
 */
export interface ScriptRunRequest {
  /** Dot-delimited tree path of the PDVScript node. */
  treePath: string;
  /** Serialised parameter values keyed by parameter name. */
  params: Record<string, string | number | boolean>;
  /** Caller-supplied execution ID for output correlation. */
  executionId: string;
  /** Execution origin metadata used in error summaries and the console. */
  origin: KernelExecutionOrigin;
}

/**
 * Result returned by `script.run`.
 */
export interface ScriptRunResult {
  /** The exact code string that was sent to the kernel (for console display). */
  code: string;
  /** Echo of the caller-supplied execution ID. */
  executionId: string;
  /** Echo of the caller-supplied origin metadata. */
  origin: KernelExecutionOrigin;
  /** Structured execution result from the kernel. */
  result: KernelExecuteResult;
}

// ---------------------------------------------------------------------------
// Modules system types
// ---------------------------------------------------------------------------

/**
 * Supported module install source kinds.
 */
export type ModuleSourceType = "github" | "local" | "bundled";

/**
 * Canonical source reference for an installed module.
 */
export interface ModuleSourceReference {
  /** Install source kind. */
  type: ModuleSourceType;
  /** Source location (GitHub URL or local path). */
  location: string;
}

/**
 * Normalized installed-module descriptor surfaced to the renderer.
 */
export interface ModuleDescriptor {
  /** Stable module identifier from manifest. */
  id: string;
  /** Human-readable module name. */
  name: string;
  /** Installed semantic version. */
  version: string;
  /** Optional short module description. */
  description?: string;
  /** Target language for this module ("python" when absent). */
  language?: "python" | "julia";
  /** Install source reference. */
  source: ModuleSourceReference;
  /** Optional resolved revision hash/tag. */
  revision?: string;
  /** Optional absolute install path in module store. */
  installPath?: string;
  /** Optional git-cloneable upstream URL for update checks. */
  upstream?: string;
}

/**
 * Request payload for `modules.install`.
 */
export interface ModuleInstallRequest {
  /** Module source to install from. */
  source: ModuleSourceReference;
}

/**
 * Result payload for `modules.install`.
 */
export interface ModuleInstallResult {
  /** True when installation/update succeeded. */
  success: boolean;
  /** Install outcome classification. */
  status:
    | "installed"
    | "up_to_date"
    | "update_available"
    | "incompatible_update"
    | "not_implemented"
    | "error";
  /** Installed/updated module metadata when available. */
  module?: ModuleDescriptor;
  /** Currently installed version when a duplicate is detected. */
  currentVersion?: string;
  /** Currently installed revision when a duplicate is detected. */
  currentRevision?: string;
  /** Optional user-facing error message. */
  error?: string;
}

/**
 * Result payload for `modules.checkUpdates`.
 */
export interface ModuleUpdateResult {
  /** Checked module ID. */
  moduleId: string;
  /** Update-check outcome classification. */
  status: "up_to_date" | "update_available" | "unknown" | "not_implemented";
  /** Currently installed version, when known. */
  currentVersion?: string;
  /** Latest available version, when known. */
  availableVersion?: string;
  /** Optional user-facing message. */
  message?: string;
}

/**
 * Request payload for `modules.importToProject`.
 */
export interface ModuleImportRequest {
  /** Module ID to import into the active project. */
  moduleId: string;
  /** Optional project-local import alias override. */
  alias?: string;
}

/**
 * Result payload for `modules.importToProject`.
 */
export interface ModuleImportResult {
  /** True when import succeeded. */
  success: boolean;
  /** Import outcome classification. */
  status: "imported" | "conflict" | "not_implemented" | "error";
  /** Resolved alias used for import when successful. */
  alias?: string;
  /** Suggested alias when conflict occurs. */
  suggestedAlias?: string;
  /** Non-blocking warnings discovered during import-time health checks. */
  warnings?: ModuleHealthWarning[];
  /** Optional user-facing error message. */
  error?: string;
}

/**
 * Request payload for `modules.createEmpty` (workflow B).
 */
export interface ModuleCreateEmptyRequest {
  /** Stable module id — also used as the top-level tree alias. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Initial semver string. */
  version: string;
  /** Optional longer description. */
  description?: string;
  /** Kernel language — defaults to the active kernel language if omitted. */
  language?: "python" | "julia";
}

/**
 * Result payload for `modules.createEmpty`.
 */
export interface ModuleCreateEmptyResult {
  /** True when the module was created. */
  success: boolean;
  /** Created module alias (equals the request id on success). */
  alias?: string;
  /** Outcome classification on failure. */
  status?: "created" | "conflict" | "error";
  /** Alternate alias suggestion when the requested id already exists. */
  suggestedAlias?: string;
  /** Optional user-facing error message. */
  error?: string;
}

/**
 * Request payload for `modules.exportFromProject`.
 */
export interface ModuleExportRequest {
  /** Project-local module alias to export. */
  alias: string;
  /**
   * If true, overwrite any existing global-store copy without prompting.
   * Defaults to false — the handler shows a confirm dialog before
   * overwriting an existing module.
   */
  overwrite?: boolean;
}

/**
 * Result payload for `modules.exportFromProject`.
 */
export interface ModuleExportResult {
  /** True when the module was published to the global store. */
  success: boolean;
  /** Outcome classification. */
  status?: "exported" | "cancelled" | "not_saved" | "error";
  /** Absolute destination directory on success. */
  destination?: string;
  /** User-facing error message when the operation fails. */
  error?: string;
}

/**
 * Request payload for `modules.updateMetadata` (workflow B metadata editor).
 */
export interface ModuleUpdateMetadataRequest {
  /** Target module alias — must refer to an existing PDVModule. */
  alias: string;
  /** New name, or omit to leave unchanged. */
  name?: string;
  /** New version, or omit to leave unchanged. */
  version?: string;
  /** New description, or omit to leave unchanged. */
  description?: string;
}

/**
 * Result payload for `modules.updateMetadata`.
 */
export interface ModuleUpdateMetadataResult {
  /** True when the update succeeded. */
  success: boolean;
  /** Echoed current metadata after the update. */
  alias?: string;
  name?: string;
  version?: string;
  description?: string;
  /** Optional user-facing error message. */
  error?: string;
}

/**
 * Primitive value type accepted by module UI controls.
 */
export type ModuleInputValue = string | number | boolean;

/**
 * One selectable option for dropdown-style module inputs.
 */
interface ModuleInputOptionDescriptor {
  /** User-facing option label. */
  label: string;
  /** Raw option value persisted in project settings. */
  value: ModuleInputValue;
}

/**
 * Declarative visibility rule for module inputs/sections.
 */
interface ModuleInputVisibilityRule {
  /** Input ID this control depends on. */
  inputId: string;
  /** Value that must match for this control to be visible. */
  equals: ModuleInputValue;
}

/**
 * Declarative input field descriptor surfaced to the renderer.
 */
export interface ModuleInputDescriptor {
  /** Stable input identifier from module manifest. */
  id: string;
  /** User-facing label. */
  label: string;
  /** Optional data type hint (e.g. "int", "float", "str"). */
  type?: string;
  /** UI control type rendered by the modules panel. */
  control?: "text" | "dropdown" | "slider" | "checkbox" | "file";
  /** Optional default value/state. */
  default?: ModuleInputValue;
  /** Optional dropdown options for `control: "dropdown"`. */
  options?: ModuleInputOptionDescriptor[];
  /** Optional tree path used to populate dropdown options from child keys. */
  optionsTreePath?: string;
  /** Optional slider/file metadata. */
  min?: number;
  max?: number;
  step?: number;
  /** Grouping metadata for module-internal tab/section layout. */
  tab?: string;
  section?: string;
  sectionCollapsed?: boolean;
  /** Optional hover tooltip. */
  tooltip?: string;
  /** Optional conditional visibility rule. */
  visibleIf?: ModuleInputVisibilityRule;
  /** Optional file picker mode for `control: "file"`. */
  fileMode?: "file" | "directory";
}

/**
 * Declarative imported-module action descriptor for renderer controls.
 */
export interface ImportedModuleActionDescriptor {
  /** Stable action identifier from module manifest. */
  id: string;
  /** User-facing action label. */
  label: string;
  /** Bound script node name under `<alias>.scripts.<scriptName>`. */
  scriptName: string;
  /** Input IDs this action reads when run. */
  inputIds?: string[];
  /** Optional module-internal tab where this action should appear. */
  tab?: string;
}

/**
 * Non-blocking module health warning surfaced to the renderer.
 */
export interface ModuleHealthWarning {
  /** Stable warning code for programmatic handling. */
  code:
    | "pdv_version_incompatible"
    | "python_version_incompatible"
    | "python_version_unknown"
    | "dependency_unverified"
    | "missing_action_script"
    | "module_source_missing";
  /** Human-readable warning detail. */
  message: string;
}

/**
 * Project-scoped imported module descriptor.
 */
export interface ImportedModuleDescriptor {
  /** Installed module ID. */
  moduleId: string;
  /** Installed module display name. */
  name: string;
  /** Project-local alias used in the tree. */
  alias: string;
  /** Imported version snapshot. */
  version: string;
  /** Optional pinned revision/hash. */
  revision?: string;
  /** True when this module has a GUI (inputs or actions). */
  hasGui: boolean;
  /** Declarative input field descriptors from module manifest. */
  inputs: ModuleInputDescriptor[];
  /** Declarative action descriptors bound for this imported module. */
  actions: ImportedModuleActionDescriptor[];
  /** Optional container layout for the module GUI. */
  gui?: ModuleGuiLayout;
  /** Persisted per-module UI settings from project manifest. */
  settings: Record<string, unknown>;
  /** Module health warnings evaluated at import/load time. */
  warnings: ModuleHealthWarning[];
}

/**
 * Request payload for `modules.saveSettings`.
 */
export interface ModuleSettingsRequest {
  /** Imported module alias settings belong to. */
  moduleAlias: string;
  /** Persisted setting values keyed by setting/control id. */
  values: Record<string, unknown>;
}

/**
 * Result payload for `modules.saveSettings`.
 */
export interface ModuleSettingsResult {
  /** True when settings persistence succeeded. */
  success: boolean;
  /** Optional user-facing error message. */
  error?: string;
}

/**
 * Request payload for `modules.runAction`.
 */
export interface ModuleActionRequest {
  /** Target kernel id used for action execution. */
  kernelId: string;
  /** Imported module alias owning the action. */
  moduleAlias: string;
  /** Module action identifier from manifest. */
  actionId: string;
  /**
   * Input values keyed by input id (from the module's input fields).
   *
   * Note: string values are passed as Python expression text; callers should
   * provide language-safe strings (e.g. quote string literals).
   */
  inputValues?: Record<string, ModuleInputValue>;
}

/**
 * Result payload for `modules.runAction`.
 */
export interface ModuleActionResult {
  /** True when action invocation succeeded. */
  success: boolean;
  /** Action invocation outcome classification. */
  status: "queued" | "not_implemented" | "error";
  /** Optional generated execution code for traceability. */
  executionCode?: string;
  /** Optional user-facing error message. */
  error?: string;
}

/**
 * Result payload for `modules.uninstall`.
 */
export interface ModuleUninstallResult {
  /** True when uninstall succeeded. */
  success: boolean;
  /** Optional user-facing error message. */
  error?: string;
}

/**
 * Payload delivered when the app menu triggers a renderer action.
 */
export interface MenuActionPayload {
  /** Action identifier emitted by the File menu. */
  action:
    | "project:new"
    | "project:open"
    | "project:openRecent"
    | "project:save"
    | "project:saveAs"
    | "recentProjects:clear"
    | "modules:import"
    | "modules:newEmpty"
    | "settings:open";
  /** Project directory path for open-recent actions. */
  path?: string;
}

/**
 * Partial map of menu item IDs to enabled/disabled state.
 * Items not present in the map default to enabled.
 */
export interface MenuEnabledState {
  "project:save"?: boolean;
  "project:saveAs"?: boolean;
  "modules:import"?: boolean;
  "modules:newEmpty"?: boolean;
}

/** Renderer-facing top-level menu button metadata. */
export interface AppMenuTopLevel {
  /** Stable top-level menu id used for popup requests. */
  id: "file" | "edit" | "view" | "window" | "help";
  /** User-visible label rendered in the custom Linux menubar. */
  label: string;
}

/** Platform-specific window chrome mode surfaced to the renderer. */
export type WindowChromePlatform = "macos" | "linux" | "windows";

/** Main-window chrome state consumed by the renderer title-bar shell. */
export interface WindowChromeInfo {
  /** Current host platform mapped into renderer-friendly naming. */
  platform: WindowChromePlatform;
  /** True when the renderer should draw the visible title bar area. */
  showCustomTitleBar: boolean;
  /** True when the renderer should show the integrated top-level menu strip. */
  showMenuBar: boolean;
  /** True when the renderer should show custom window controls. */
  showWindowControls: boolean;
  /** True when the main window is currently maximized. */
  isMaximized: boolean;
}

// ---------------------------------------------------------------------------
// Module window types
// ---------------------------------------------------------------------------

/**
 * Request payload for opening a module popup window.
 */
export interface ModuleWindowOpenRequest {
  /** Project-local module alias identifying the imported module. */
  alias: string;
  /** Active kernel ID for the module window context. */
  kernelId: string;
}

/**
 * Result payload for `moduleWindows.open`.
 */
export interface ModuleWindowOpenResult {
  /** True when the window was opened or focused successfully. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
}

/**
 * Context payload returned to a module popup window identifying its module.
 */
export interface ModuleWindowContext {
  /** Project-local module alias. */
  alias: string;
  /** Active kernel ID. */
  kernelId: string;
}

// ---------------------------------------------------------------------------
// GUI editor types
// ---------------------------------------------------------------------------

/**
 * Action descriptor as stored on disk in gui.json.
 *
 * Distinct from {@link ImportedModuleActionDescriptor} which uses `scriptName`
 * (the resolved tree key after module import). This type uses `script_path`
 * (the raw relative path from the manifest).
 */
export interface GuiActionDescriptor {
  /** Stable action identifier. */
  id: string;
  /** User-facing action label. */
  label: string;
  /** Script path relative to the GUI node's parent in the tree. */
  script_path: string;
  /** Input IDs this action reads when run. */
  inputs?: string[];
}

/**
 * Complete GUI manifest as stored in `.gui.json` files.
 */
export interface GuiManifestV1 {
  /** Whether this manifest defines a renderable GUI. */
  has_gui: boolean;
  /** Container layout definition. */
  gui?: ModuleGuiLayout;
  /** Declarative input field descriptors. */
  inputs: ModuleInputDescriptor[];
  /** Declarative action descriptors. */
  actions: GuiActionDescriptor[];
}

/**
 * Request payload for opening a GUI editor window.
 */
export interface GuiEditorOpenRequest {
  /** Dot-delimited tree path of the PDVGui node to edit. */
  treePath: string;
  /** Active kernel ID. */
  kernelId: string;
}

/**
 * Result payload for `guiEditor.open`.
 */
export interface GuiEditorOpenResult {
  /** True when the editor window was opened or focused successfully. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
}

/**
 * Context payload returned to a GUI editor window identifying its target.
 */
export interface GuiEditorContext {
  /** Dot-delimited tree path of the PDVGui node being edited. */
  treePath: string;
  /** Active kernel ID. */
  kernelId: string;
}

/**
 * Result payload for `guiEditor.read`.
 */
export interface GuiEditorReadResult {
  /** True when the manifest was read successfully. */
  success: boolean;
  /** Parsed GUI manifest content. */
  manifest?: GuiManifestV1;
  /** Optional error message when `success` is false. */
  error?: string;
}

/**
 * Request payload for `guiEditor.save`.
 */
export interface GuiEditorSaveRequest {
  /** Dot-delimited tree path of the PDVGui node to write. */
  treePath: string;
  /** Updated manifest content to persist. */
  manifest: GuiManifestV1;
}

/**
 * Result payload for `guiEditor.save`.
 */
export interface GuiEditorSaveResult {
  /** True when the manifest was written successfully. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
}

/**
 * Result returned by `tree.createGui`.
 */
export interface TreeCreateGuiResult {
  /** True when GUI creation and registration succeeded. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
  /** Absolute path to the created .gui.json file. */
  guiPath?: string;
  /** Dot-path of the created tree node. */
  treePath?: string;
}

/**
 * Result returned by `tree.createLib`.
 *
 * ``tree:createLib`` is workflow-B-only: it creates a new ``.py`` file
 * under ``<module_alias>.lib`` (or a nested sub-path thereof). When the
 * target does not live inside a known module alias, the handler returns
 * ``{ success: false, error }``.
 */
export interface TreeCreateLibResult {
  /** True when the lib file was created and the node was registered. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
  /** Absolute working-dir path to the created .py file. */
  libPath?: string;
  /** Dot-path of the created PDVLib tree node. */
  treePath?: string;
}

// ---------------------------------------------------------------------------
// Container layout types
// ---------------------------------------------------------------------------

/**
 * Reference to an input declared in the manifest `inputs[]` array.
 */
export interface LayoutInputRef {
  type: "input";
  /** References an entry in inputs[] by id. */
  id: string;
}

/**
 * Reference to an action declared in the manifest `actions[]` array.
 */
export interface LayoutActionRef {
  type: "action";
  /** References an entry in actions[] by id. */
  id: string;
}

/**
 * A layout container that arranges children visually.
 */
export interface LayoutContainer {
  type: "row" | "column" | "group" | "tabs";
  /** Display label (required for "group" and tab items). */
  label?: string;
  /** Initial collapsed state for "group" containers. */
  collapsed?: boolean;
  /** Nested layout nodes. */
  children: LayoutNode[];
}

/**
 * Reference to a namelist file in the tree, rendered as an inline editor.
 */
export interface LayoutNamelistRef {
  type: "namelist";
  /** Dot-path to the PDVNamelist tree node. */
  tree_path: string;
  /** Optional input ID whose value overrides the tree path dynamically. */
  tree_path_input?: string;
}

/**
 * A layout node is either an input reference, action reference, namelist reference, or a container.
 */
export type LayoutNode = LayoutInputRef | LayoutActionRef | LayoutNamelistRef | LayoutContainer;

/**
 * Top-level GUI layout object in the module manifest.
 */
export interface ModuleGuiLayout {
  /** Root layout — typically a "tabs" container or a single "column". */
  layout: LayoutContainer;
}

// ---------------------------------------------------------------------------
// Theme and code-cell persistence types
// ---------------------------------------------------------------------------

/**
 * Theme object persisted by `themes.save`.
 */
export interface Theme {
  /** Stable theme name/identifier. */
  name: string;
  /** Map of semantic color keys to CSS color values. */
  colors: Record<string, string>;
}

/**
 * Code-cell tab model persisted by `codeCells.save`.
 */
export interface CodeCellData {
  /** Tab list in display order. */
  tabs: Array<{
    /** Stable tab ID. */
    id: number;
    /** Code content in the tab editor. */
    code: string;
    /** Optional user-defined name. When absent, the tab is labelled by its 1-based position. */
    name?: string;
  }>;
  /** ID of the currently selected tab. */
  activeTabId: number;
}

// ---------------------------------------------------------------------------
// Push payload aliases
// ---------------------------------------------------------------------------

/**
 * Payload delivered on `IPC.push.treeChanged`.
 */
export type TreeChangedPayload = PDVTreeChangedPayload;

/**
 * Payload delivered on `IPC.push.projectLoaded`.
 */
export type ProjectLoadedPayload = PDVProjectLoadedPayload;

/**
 * Result returned from `project.save()`.
 */
export interface ProjectSaveResult {
  /** SHA-256 checksum of the serialized tree-index.json. */
  checksum: string;
  /** Number of tree nodes serialized. */
  nodeCount: number;
  /** Project name stored in the manifest (may be absent for older projects). */
  projectName?: string;
}

/**
 * Result returned from `project.load()`.
 */
export interface ProjectLoadResult {
  /** Loaded code-cell state from code-cells.json. */
  codeCells: unknown;
  /** SHA-256 checksum stored in the project manifest, or null if absent. */
  checksum: string | null;
  /** Whether the stored checksum matches the computed checksum of tree-index.json. */
  checksumValid: boolean | null;
  /** Number of tree nodes loaded. */
  nodeCount: number | null;
  /** PDV version stored in the project manifest, or null if absent. */
  savedPdvVersion: string | null;
  /** Project name stored in the manifest, or null if absent. */
  projectName: string | null;
}

/**
 * Lightweight manifest peek returned before kernel start.
 */
export interface ProjectManifestPeek {
  /** Kernel language used by this project. */
  language: "python" | "julia";
  /** Interpreter path saved with the project, if any. */
  interpreterPath?: string;
  /** PDV version the project was saved with. */
  pdvVersion?: string;
  /** Project name stored in the manifest. */
  projectName?: string;
}

/**
 * Progress update payload pushed during save/load operations.
 */
export interface ProgressPayload {
  /** The operation in progress. */
  operation: "save" | "load";
  /** Short human-readable phase label (e.g. "Serializing", "Copying files"). */
  phase: string;
  /** Nodes processed so far. */
  current: number;
  /** Total node count. */
  total: number;
}

// ---------------------------------------------------------------------------
// Preload API surface
// ---------------------------------------------------------------------------

/**
 * Fully typed API exposed to the renderer as `window.pdv`.
 *
 * Every method corresponds to one IPC request channel. Push subscriptions are
 * exposed as callback registration helpers.
 */
export interface PDVApi {
  /** Kernel lifecycle and execution methods. */
  kernels: {
    /**
     * List running kernels.
     *
     * @returns Current running kernel metadata.
     */
    list(): Promise<KernelInfo[]>;
    /**
     * Start a new kernel process.
     *
     * @param spec - Optional kernel spec override.
     * @returns Started kernel metadata.
     */
    start(spec?: Partial<KernelSpec>): Promise<KernelInfo>;
    /**
     * Stop a running kernel.
     *
     * @param kernelId - Kernel ID to stop.
     * @returns True when the stop request was accepted.
     */
    stop(kernelId: string): Promise<boolean>;
    /**
     * Execute code in a kernel.
     *
     * @param kernelId - Target kernel ID.
     * @param request - Execute request payload.
     * @returns Structured execution result.
     */
    execute(
      kernelId: string,
      request: KernelExecuteRequest
    ): Promise<KernelExecuteResult>;
    /**
     * Interrupt a running kernel execution.
     *
     * @param kernelId - Target kernel ID.
     * @returns True when the interrupt request was accepted.
     */
    interrupt(kernelId: string): Promise<boolean>;
    /**
     * Restart a running kernel.
     *
     * @param kernelId - Target kernel ID.
     * @returns Newly started kernel metadata.
     */
    restart(kernelId: string): Promise<KernelInfo>;
    /**
     * Request code completion from a kernel.
     *
     * @param kernelId - Target kernel ID.
     * @param code - Source text around the cursor.
     * @param cursorPos - Cursor index in `code`.
     * @returns Completion result payload.
     */
    complete(
      kernelId: string,
      code: string,
      cursorPos: number
    ): Promise<KernelCompleteResult>;
    /**
     * Request symbol inspection/doc info from a kernel.
     *
     * @param kernelId - Target kernel ID.
     * @param code - Source text around the cursor.
     * @param cursorPos - Cursor index in `code`.
     * @returns Inspection result payload.
     */
    inspect(
      kernelId: string,
      code: string,
      cursorPos: number
    ): Promise<KernelInspectResult>;
    /**
     * Validate an executable path for a target language.
     *
     * @param executablePath - Candidate executable path or command.
     * @param language - Language runtime to validate.
     * @returns Validation status payload.
     */
    validate(
      executablePath: string,
      language: "python" | "julia"
    ): Promise<KernelValidateResult>;
    /**
     * Subscribe to streaming output chunks from any active execution.
     *
     * @param callback - Invoked for each chunk as it arrives from the kernel.
     * @returns Unsubscribe function.
     */
    onOutput(callback: (chunk: ExecuteOutputChunk) => void): () => void;
    /**
     * Subscribe to kernel crash push notifications. Fires only when the
     * kernel subprocess exits unexpectedly.
     *
     * @param callback - Invoked with the crashed kernel ID.
     * @returns Unsubscribe function.
     */
    onKernelCrashed(callback: (payload: { kernelId: string }) => void): () => void;
  };

  /** Tree browsing and updates. */
  tree: {
    /**
     * List child nodes at a tree path.
     *
     * @param kernelId - Target kernel ID.
     * @param path - Optional dot-path to list. Empty string lists root.
     * @returns Tree nodes at the requested level.
     */
    list(kernelId: string, path?: string): Promise<TreeNode[]>;
    /**
     * Resolve one tree node value/preview payload.
     *
     * @param kernelId - Target kernel ID.
     * @param path - Dot-path of the requested node.
     * @returns Message payload from `pdv.tree.get.response`.
     */
    get(kernelId: string, path: string): Promise<Record<string, unknown>>;
    /**
     * Create and register a new script node.
     *
     * @param kernelId - Target kernel ID.
     * @param targetPath - Dot-path under which to register the script.
     * @param scriptName - Script base filename.
     * @returns Script creation result payload.
     */
    createScript(
      kernelId: string,
      targetPath: string,
      scriptName: string
    ): Promise<TreeCreateScriptResult>;
    /**
     * Create and register a new markdown note node.
     *
     * @param kernelId - Target kernel ID.
     * @param targetPath - Dot-path under which to register the note.
     * @param noteName - Note base name (without .md extension).
     * @returns Note creation result payload.
     */
    createNote(
      kernelId: string,
      targetPath: string,
      noteName: string
    ): Promise<TreeCreateNoteResult>;
    /**
     * Create and register a new GUI node.
     *
     * @param kernelId - Target kernel ID.
     * @param targetPath - Dot-path under which to register the GUI.
     * @param guiName - GUI base name (without .gui.json extension).
     * @returns GUI creation result payload.
     */
    createGui(
      kernelId: string,
      targetPath: string,
      guiName: string
    ): Promise<TreeCreateGuiResult>;
    /**
     * Create a new PDVLib (`.py`) node inside a module's `lib` subtree.
     *
     * Workflow B only — ``targetPath`` must live under a known module
     * alias. Writes an empty ``<stem>.py`` to
     * ``<workdir>/<alias>/.../<stem>.py`` and registers the node via
     * ``pdv.file.register`` with ``source_rel_path`` set so §3's
     * save-time sync mirrors future edits back to
     * ``<saveDir>/modules/<alias>/.../<stem>.py``.
     *
     * @param kernelId - Target kernel ID.
     * @param targetPath - Dot-path under which to register the lib.
     * @param libName - Lib base name (optional ``.py`` suffix is stripped).
     * @returns Lib creation result payload.
     */
    createLib(
      kernelId: string,
      targetPath: string,
      libName: string
    ): Promise<TreeCreateLibResult>;
    /**
     * Copy a file into the kernel working directory and register it as a tree node.
     *
     * @param kernelId - Target kernel ID.
     * @param sourcePath - Absolute path to the source file to copy.
     * @param targetTreePath - Dot-path of the parent tree node.
     * @param nodeType - Node type classification for the file.
     * @param filename - Physical filename with extension.
     * @returns File addition result payload.
     */
    addFile(
      kernelId: string,
      sourcePath: string,
      targetTreePath: string,
      nodeType: "namelist" | "lib" | "file",
      filename: string
    ): Promise<TreeAddFileResult>;
    /**
     * Invoke a registered custom handler for a tree node.
     *
     * @param kernelId - Target kernel ID.
     * @param path - Dot-path of the tree node to handle.
     * @returns Handler invocation result.
     */
    invokeHandler(
      kernelId: string,
      path: string
    ): Promise<HandlerInvokeResult>;
    /**
     * Delete a tree node by dot-path.
     *
     * @param kernelId - Target kernel ID.
     * @param treePath - Dot-separated path of the node to delete.
     * @returns Success/error result.
     */
    delete(
      kernelId: string,
      treePath: string
    ): Promise<{ success: boolean; error?: string }>;
    /**
     * Subscribe to tree change push notifications.
     *
     * @param callback - Invoked with each tree-changed payload.
     * @returns Unsubscribe function.
     */
    onChanged(callback: (payload: TreeChangedPayload) => void): () => void;
  };

  /** Namespace inspection operations. */
  namespace: {
    /**
     * Query variables in the kernel namespace.
     *
     * @param kernelId - Target kernel ID.
     * @param options - Optional visibility filters.
     * @returns Variable descriptor array.
     */
    query(
      kernelId: string,
      options?: NamespaceQueryOptions
    ): Promise<NamespaceVariable[]>;
    /**
     * Lazily inspect the children of one namespace value.
     *
     * @param kernelId - Target kernel ID.
     * @param target - Root variable plus selector path to inspect.
     * @returns One-level child inspector rows.
     */
    inspect(
      kernelId: string,
      target: NamespaceInspectTarget
    ): Promise<NamespaceInspectResult>;
  };

  /** Script tooling operations. */
  script: {
    /**
     * Run a PDVScript tree node in the target kernel.
     *
     * The main process builds the language-appropriate invocation code
     * (Python or Julia) and executes it via the kernel, returning both
     * the code string and the execution result so the renderer can
     * display the run in the console.
     *
     * @param kernelId - Target kernel ID.
     * @param request - Script run request payload.
     * @returns Execution result including the generated code string.
     */
    run(kernelId: string, request: ScriptRunRequest): Promise<ScriptRunResult>;
    /**
     * Open a script path in the configured external editor.
     *
     * @param kernelId - Target kernel ID.
     * @param scriptPath - Script path to edit.
     * @returns Operation status.
     */
    edit(kernelId: string, scriptPath: string): Promise<ScriptOperationResult>;
    /**
     * Fetch the current run() parameters for a script node.
     *
     * Reads the script file fresh from disk each time so edits are
     * reflected immediately.
     *
     * @param kernelId - Target kernel ID.
     * @param treePath - Dot-delimited tree path of the script node.
     * @returns Array of parameter descriptors.
     */
    getParams(kernelId: string, treePath: string): Promise<ScriptParameter[]>;
  };

  /** Markdown note operations. */
  note: {
    /**
     * Save markdown note content to its backing file.
     *
     * @param kernelId - Target kernel ID (used to resolve working directory).
     * @param treePath - Dot-delimited tree path of the note node.
     * @param content - Full markdown content to write.
     * @returns Operation status.
     */
    save(kernelId: string, treePath: string, content: string): Promise<{ success: boolean; error?: string }>;
    /**
     * Read markdown note content from its backing file.
     *
     * @param kernelId - Target kernel ID (used to resolve working directory).
     * @param treePath - Dot-delimited tree path of the note node.
     * @returns File content.
     */
    read(kernelId: string, treePath: string): Promise<{ success: boolean; content?: string; error?: string }>;
  };

  /** Namelist read/write operations. */
  namelist: {
    /**
     * Read and parse a namelist file from the tree.
     *
     * @param kernelId - Target kernel ID.
     * @param treePath - Dot-path to the PDVNamelist tree node.
     * @returns Parsed namelist data with hints and types.
     */
    read(kernelId: string, treePath: string): Promise<NamelistReadResult>;
    /**
     * Write edited namelist data back to the backing file.
     *
     * @param kernelId - Target kernel ID.
     * @param treePath - Dot-path to the PDVNamelist tree node.
     * @param data - Updated group data to write.
     * @returns Write result payload.
     */
    write(kernelId: string, treePath: string, data: Record<string, Record<string, unknown>>): Promise<NamelistWriteResult>;
  };

  /** Modules install/import/action operations. */
  modules: {
    /**
     * List globally installed modules available to import.
     *
     * @returns Installed module descriptors.
     */
    listInstalled(): Promise<ModuleDescriptor[]>;
    /**
     * Install a module from GitHub URL or local path.
     *
     * @param request - Installation source payload.
     * @returns Installation result payload.
     */
    install(request: ModuleInstallRequest): Promise<ModuleInstallResult>;
    /**
     * Check whether an installed module has an update available.
     *
     * @param moduleId - Installed module identifier.
     * @returns Update-check result payload.
     */
    checkUpdates(moduleId: string): Promise<ModuleUpdateResult>;
    /**
     * Import an installed module into the active project.
     *
     * @param request - Project import request.
     * @returns Import result payload.
     */
    importToProject(request: ModuleImportRequest): Promise<ModuleImportResult>;
    /**
     * List modules imported in the active project.
     *
     * @returns Imported module descriptors.
     */
    listImported(): Promise<ImportedModuleDescriptor[]>;
    /**
     * Persist project-scoped settings for an imported module.
     *
     * @param request - Settings payload.
     * @returns Save result payload.
     */
    saveSettings(request: ModuleSettingsRequest): Promise<ModuleSettingsResult>;
    /**
     * Run one module action using manifest-bound script execution.
     *
     * @param request - Action invocation payload.
     * @returns Action invocation result payload.
     */
    runAction(request: ModuleActionRequest): Promise<ModuleActionResult>;
    /**
     * Remove an imported module from the active project by alias.
     *
     * @param moduleAlias - The project-local alias to remove.
     * @returns Removal result payload.
     */
    removeImport(moduleAlias: string): Promise<ModuleSettingsResult>;
    /**
     * Uninstall a module from the global store.
     *
     * @param moduleId - Module identifier to uninstall.
     * @returns Uninstall result payload.
     */
    uninstall(moduleId: string): Promise<ModuleUninstallResult>;
    /**
     * Update an installed module from its upstream source.
     *
     * @param moduleId - Module identifier to update.
     * @returns Install result payload reflecting the update outcome.
     */
    update(moduleId: string): Promise<ModuleInstallResult>;
    /**
     * Create a brand-new empty PDVModule in the active project
     * (workflow B of issue #140).
     *
     * @param request - Module identity + initial metadata.
     * @returns Create result payload.
     */
    createEmpty(request: ModuleCreateEmptyRequest): Promise<ModuleCreateEmptyResult>;
    /**
     * Patch mutable metadata fields on an existing PDVModule.
     *
     * @param request - Partial metadata payload — omitted fields are left unchanged.
     * @returns Update result payload.
     */
    updateMetadata(request: ModuleUpdateMetadataRequest): Promise<ModuleUpdateMetadataResult>;
    /**
     * Publish the project-local copy of a module to the global store.
     *
     * @param request - Export request payload (alias + overwrite flag).
     * @returns Export result payload.
     */
    exportFromProject(request: ModuleExportRequest): Promise<ModuleExportResult>;
  };

  /** Project save/load operations. */
  project: {
    /**
     * Save the current project.
     *
      * @param saveDir - Target save directory.
      * @param codeCells - Code-cell payload to persist.
      * @returns True when save request is accepted.
      */
    save(saveDir: string, codeCells: unknown, projectName?: string): Promise<ProjectSaveResult>;
    /**
     * Load an existing project.
     *
     * @param saveDir - Source save directory.
      * @returns Loaded code-cell state with checksum metadata.
      */
    load(saveDir: string): Promise<ProjectLoadResult>;
    /**
     * Start a new empty project session.
     *
     * @returns True when a new project was created/reset.
     */
    new: () => Promise<boolean>;
    /**
     * Peek at the language field of project.json for each given directory.
     *
     * Reads only the manifest — does not load the project into the kernel.
     * Directories without a valid project.json default to "python".
     *
     * @param paths - Project directory paths to inspect.
     * @returns Map of path → language.
     */
    peekLanguages(paths: string[]): Promise<Record<string, "python" | "julia">>;
    /**
     * Read lightweight manifest data from a project directory without starting
     * a kernel. Returns language, interpreter path, and PDV version.
     *
     * @param dir - Absolute path to the project directory.
     * @returns Manifest peek data.
     */
    peekManifest(dir: string): Promise<ProjectManifestPeek>;
    /**
     * Subscribe to project-loaded push notifications.
     *
     * @param callback - Invoked with each project-loaded payload.
     * @returns Unsubscribe function.
     */
    onLoaded(callback: (payload: ProjectLoadedPayload) => void): () => void;
    /**
     * Subscribe to project-reloading status push notifications (during kernel restart).
     *
     * @param callback - Invoked with `{ status: "reloading" | "ready" }`.
     * @returns Unsubscribe function.
     */
    onReloading(callback: (payload: { status: "reloading" | "ready" }) => void): () => void;
  };

  /** Save/load progress push subscription. */
  progress: {
    /**
     * Subscribe to progress updates during save/load operations.
     *
     * @param callback - Invoked with each progress payload.
     * @returns Unsubscribe function.
     */
    onProgress(callback: (payload: ProgressPayload) => void): () => void;
  };

  /** Python environment discovery and installation. */
  environment: {
    /**
     * List all detected Python environments with package installation status.
     *
     * @returns Enriched environment info array, ordered by priority.
     */
    list(): Promise<EnvironmentInfo[]>;
    /**
     * Re-probe a single Python path and return its current status.
     *
     * Bypasses the cache — useful for refreshing a selected environment
     * after the user installs packages externally.
     *
     * @param pythonPath - Path to the Python executable to check.
     * @returns Enriched environment info, or null if the path is invalid.
     */
    check(pythonPath: string): Promise<EnvironmentInfo | null>;
    /**
     * Install pdv-python from the bundled source into a Python environment.
     *
     * Streams pip output via the `installOutput` push channel. Subscribe
     * to `onInstallOutput` before calling this method to receive live chunks.
     *
     * @param pythonPath - Target Python executable.
     * @returns Install result with success flag and full output.
     */
    install(pythonPath: string): Promise<EnvironmentInstallResult>;
    /**
     * Clear the environment detection cache and re-discover all environments.
     *
     * @returns Freshly detected environment info array.
     */
    refresh(): Promise<EnvironmentInfo[]>;
    /**
     * Subscribe to streaming pip install output chunks.
     *
     * @param callback - Invoked with each output chunk as it arrives.
     * @returns Unsubscribe function.
     */
    onInstallOutput(callback: (chunk: InstallOutputChunk) => void): () => void;
  };

  /** App configuration accessors. */
  config: {
    /**
     * Fetch current merged app configuration.
     *
     * @returns Current config object.
     */
    get(): Promise<PDVConfig>;
    /**
     * Persist a partial configuration update.
     *
     * @param updates - Partial config patch.
     * @returns Updated merged config object.
     */
    set(updates: Partial<PDVConfig>): Promise<PDVConfig>;
  };

  /** App info accessors. */
  about: {
    /**
     * Return the running app version string from package.json.
     *
     * @returns Version string, e.g. "0.0.2".
     */
    getVersion(): Promise<string>;
  };

  /** App auto-update operations. */
  updater: {
    /** Trigger an update check against GitHub Releases. */
    checkForUpdates(): Promise<void>;
    /** Download the available update. */
    downloadUpdate(): Promise<void>;
    /** Quit and install the downloaded update. */
    installUpdate(): Promise<void>;
    /** Open the GitHub Releases page in the system browser. */
    openReleasesPage(): Promise<void>;
    /** Subscribe to update status push notifications. */
    onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  };

  /** Theme persistence operations. */
  themes: {
    /**
     * Load available themes.
     *
     * @returns Theme array.
     */
    get(): Promise<Theme[]>;
    /**
     * Save or update one theme.
     *
     * @param theme - Theme payload to persist.
     * @returns True when save succeeded.
     */
    save(theme: Theme): Promise<boolean>;
    /**
     * Open the themes directory in the system file manager.
     *
     * @returns The error string from shell.openPath, or empty string on success.
     */
    openDir(): Promise<string>;
  };

  /** Code-cell persistence operations. */
  codeCells: {
    /**
     * Load persisted code-cell tab state.
     *
     * @returns Last saved state or null if none exists.
     */
    load(): Promise<CodeCellData | null>;
    /**
     * Save code-cell tab state.
     *
     * @param data - State payload to persist.
     * @returns True when save succeeded.
     */
    save(data: CodeCellData): Promise<boolean>;
  };

  /** Module popup window operations. */
  moduleWindows: {
    /**
     * Open (or focus) a module GUI popup window.
     *
     * @param request - Module alias and kernel ID.
     * @returns Open result payload.
     */
    open(request: ModuleWindowOpenRequest): Promise<ModuleWindowOpenResult>;
    /**
     * Close a module GUI popup window.
     *
     * @param alias - Module alias whose window to close.
     * @returns True when a window was closed.
     */
    close(alias: string): Promise<boolean>;
    /**
     * Get the module context for the calling popup window.
     *
     * @returns Context payload, or null if called from the main window.
     */
    context(): Promise<ModuleWindowContext | null>;
    /**
     * Route code execution from a popup window to the main window console.
     *
     * @param code - Python code to execute.
     */
    executeInMain(code: string): Promise<void>;
    /**
     * Subscribe to execution requests from module popup windows.
     *
     * @param callback - Invoked with the code string to execute.
     * @returns Unsubscribe function.
     */
    onExecuteRequest(callback: (code: string) => void): () => void;
  };

  /** GUI editor popup window operations. */
  guiEditor: {
    /**
     * Open (or focus) a GUI editor window for a PDVGui tree node.
     *
     * @param request - Tree path and kernel ID.
     * @returns Open result payload.
     */
    open(request: GuiEditorOpenRequest): Promise<GuiEditorOpenResult>;
    /**
     * Open (or focus) a standalone GUI viewer window for a PDVGui tree node.
     *
     * @param request - Tree path and kernel ID.
     * @returns Open result payload.
     */
    openViewer(request: GuiEditorOpenRequest): Promise<GuiEditorOpenResult>;
    /**
     * Get the editor/viewer context for the calling window.
     *
     * @returns Context payload, or null if called from a non-editor/viewer window.
     */
    context(): Promise<GuiEditorContext | null>;
    /**
     * Read the gui.json manifest backing a PDVGui tree node.
     *
     * @param treePath - Dot-path of the PDVGui node.
     * @returns Parsed manifest content.
     */
    read(treePath: string): Promise<GuiEditorReadResult>;
    /**
     * Write an updated gui.json manifest back to the PDVGui backing file.
     *
     * @param request - Tree path and updated manifest.
     * @returns Save result payload.
     */
    save(request: GuiEditorSaveRequest): Promise<GuiEditorSaveResult>;
  };

  /** Native file/directory pickers (main process dialog wrappers). */
  files: {
    /**
     * Open a native file picker for selecting an executable path.
     *
     * @returns Selected file path, or null if cancelled.
     */
    pickExecutable(): Promise<string | null>;
    /**
     * Open a native file picker.
     *
     * @returns Selected file path, or null if cancelled.
     */
    pickFile(): Promise<string | null>;
    /**
     * Open a native directory picker (with create-directory support).
     *
     * @returns Selected directory path, or null if cancelled.
     */
    pickDirectory(defaultPath?: string): Promise<string | null>;
  };

  /** App menu integration. */
  menu: {
    /**
     * Push the latest recent-project paths into the File → Open Recent submenu.
     *
     * @param paths - Recent project directories (most recent first).
     * @returns True when the menu was updated.
     */
    updateRecentProjects(paths: string[]): Promise<boolean>;
    /**
     * Update enabled/disabled state for File-menu items.
     *
     * @param state - Partial map of menu-item IDs to enabled booleans.
     * @returns True when the menu was updated.
     */
    updateEnabled(state: MenuEnabledState): Promise<boolean>;
    /**
     * Return the top-level menu structure for the custom Linux menubar.
     *
     * @returns Ordered top-level menu button metadata.
     */
    getModel(): Promise<AppMenuTopLevel[]>;
    /**
     * Open one native submenu popup anchored to the given window coordinates.
     *
     * Coordinates are relative to the content area of the main window.
     *
     * @param menuId - Top-level menu id to display.
     * @param x - Left anchor coordinate in window CSS pixels.
     * @param y - Top anchor coordinate in window CSS pixels.
     * @returns True when a matching submenu was opened.
     */
    popup(menuId: AppMenuTopLevel["id"], x: number, y: number): Promise<boolean>;
    /**
     * Subscribe to app-menu action events.
     *
     * @param callback - Invoked for File-menu actions.
     * @returns Unsubscribe function.
     */
    onAction(callback: (payload: MenuActionPayload) => void): () => void;
  };

  /** App-level lifecycle controls (window close confirmation, etc.). */
  app: {
    /**
     * Confirm that the renderer has approved closing the main window.
     *
     * Called from the renderer after the user resolves the unsaved-changes
     * prompt. Sets the main-process "allow close" flag and re-issues
     * `BrowserWindow.close()` so the OS-level close proceeds.
     *
     * @returns Resolves when the close has been re-issued.
     */
    confirmClose(): Promise<void>;
    /**
     * Subscribe to "user is trying to close" notifications from the main
     * process. Fired both for the title-bar close button and for OS-level
     * window close (Cmd+Q on macOS, Alt+F4, etc.).
     *
     * @param callback - Invoked once per close attempt.
     * @returns Unsubscribe function.
     */
    onRequestClose(callback: () => void): () => void;
  };

  /** Window chrome integration and title-bar controls. */
  chrome: {
    /**
     * Return platform-specific window-chrome settings for the renderer shell.
     *
     * @returns Current main-window chrome configuration and state.
     */
    getInfo(): Promise<WindowChromeInfo>;
    /**
     * Minimize the main window when supported.
     *
     * @returns True when the request was accepted.
     */
    minimize(): Promise<boolean>;
    /**
     * Maximize or restore the main window depending on current state.
     *
     * @returns Updated maximize state.
     */
    toggleMaximize(): Promise<boolean>;
    /**
     * Close the main window.
     *
     * @returns True when the request was accepted.
     */
    close(): Promise<boolean>;
    /**
     * Subscribe to maximize/fullscreen state changes for the main window.
     *
     * @param callback - Invoked with the latest chrome info snapshot.
     * @returns Unsubscribe function.
     */
    onStateChanged(callback: (info: WindowChromeInfo) => void): () => void;
  };
}
