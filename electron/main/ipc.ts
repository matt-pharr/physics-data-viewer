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
import type { PDVConfig } from "./config";

export type { PDVConfig } from "./config";

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
  },
  /** Namespace inspection channels. */
  namespace: {
    query: "namespace:query",
  },
  /** Script tooling channels. */
  script: {
    edit: "script:edit",
    reload: "script:reload",
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
  },
  /** Project lifecycle channels. */
  project: {
    save: "project:save",
    load: "project:load",
    new: "project:new",
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
  /** Theme persistence channels. */
  themes: {
    get: "themes:get",
    save: "themes:save",
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
    kernelStatus: "pdv.kernel.status",
    menuAction: "menu:action",
    executeOutput: "pdv.execute.output",
  },
  /** App menu synchronization channels. */
  menu: {
    updateRecentProjects: "menu:updateRecentProjects",
  },
  /** Native file/directory picker channels. */
  files: {
    pickExecutable: "files:pickExecutable",
    pickFile: "files:pickFile",
    pickDirectory: "files:pickDirectory",
  },
  /** Window lifecycle channels (unsaved-changes flow). */
  lifecycle: {
    confirmClose: "lifecycle:confirmClose",
    closeResponse: "lifecycle:closeResponse",
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

/**
 * Descriptor for a single variable in the namespace panel.
 */
export interface NamespaceVariable {
  /** Variable name in the user namespace. */
  name: string;
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
  /** Optional short UI preview string. */
  preview?: string;
}

// ---------------------------------------------------------------------------
// Tree and script types
// ---------------------------------------------------------------------------

/**
 * Script run() parameter descriptor surfaced in script node metadata.
 */
export interface ScriptParameter extends PDVScriptParameter {}

/**
 * Tree node shape returned to the renderer.
 */
export interface TreeNode extends NodeDescriptor {
  /** Present only when type === 'script'. */
  params?: ScriptParameter[] | undefined;
}

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
 * Result returned by `script.edit` and `script.reload`.
 */
export interface ScriptOperationResult {
  /** True when the operation succeeded. */
  success: boolean;
  /** Optional error message when `success` is false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Modules system types
// ---------------------------------------------------------------------------

/**
 * Supported module install source kinds.
 */
export type ModuleSourceType = "github" | "local";

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
  /** Install source reference. */
  source: ModuleSourceReference;
  /** Optional resolved revision hash/tag. */
  revision?: string;
  /** Optional absolute install path in module store. */
  installPath?: string;
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
 * Primitive value type accepted by module UI controls.
 */
export type ModuleInputValue = string | number | boolean;

/**
 * One selectable option for dropdown-style module inputs.
 */
export interface ModuleInputOptionDescriptor {
  /** User-facing option label. */
  label: string;
  /** Raw option value persisted in project settings. */
  value: ModuleInputValue;
}

/**
 * Declarative visibility rule for module inputs/sections.
 */
export interface ModuleInputVisibilityRule {
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
  /** Declarative input field descriptors from module manifest. */
  inputs: ModuleInputDescriptor[];
  /** Declarative action descriptors bound for this imported module. */
  actions: ImportedModuleActionDescriptor[];
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
  /** Input values keyed by input id (from the module's input fields). */
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
 * Response from the renderer when the main process asks to confirm close.
 */
export interface ConfirmCloseResponse {
  /** User's chosen action. */
  action: "save" | "discard" | "cancel";
}

/**
 * Payload delivered when the app menu triggers a renderer action.
 */
export interface MenuActionPayload {
  /** Action identifier emitted by the File menu. */
  action:
    | "project:open"
    | "project:openRecent"
    | "project:save"
    | "project:saveAs";
  /** Project directory path for open-recent actions. */
  path?: string;
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
  };

  /** Script tooling operations. */
  script: {
    /**
     * Open a script path in the configured external editor.
     *
     * @param kernelId - Target kernel ID.
     * @param scriptPath - Script path to edit.
     * @returns Operation status.
     */
    edit(kernelId: string, scriptPath: string): Promise<ScriptOperationResult>;
    /**
     * Re-register a script with reload semantics.
     *
     * @param scriptPath - Script path to reload.
     * @returns Operation status.
     */
    reload(scriptPath: string): Promise<ScriptOperationResult>;
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
    save(saveDir: string, codeCells: unknown): Promise<boolean>;
    /**
     * Load an existing project.
     *
     * @param saveDir - Source save directory.
      * @returns Loaded code-cell state.
      */
    load(saveDir: string): Promise<unknown>;
    /**
     * Start a new empty project session.
     *
     * @returns True when a new project was created/reset.
     */
    new: () => Promise<boolean>;
    /**
     * Subscribe to project-loaded push notifications.
     *
     * @param callback - Invoked with each project-loaded payload.
     * @returns Unsubscribe function.
     */
    onLoaded(callback: (payload: ProjectLoadedPayload) => void): () => void;
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
    pickDirectory(): Promise<string | null>;
  };

  /** Window lifecycle (unsaved-changes flow). */
  lifecycle: {
    /**
     * Subscribe to close-confirmation requests from the main process.
     *
     * @param callback - Invoked when the main process wants to close the window.
     * @returns Unsubscribe function.
     */
    onConfirmClose(callback: () => void): () => void;
    /**
     * Send the user's close-confirmation decision back to the main process.
     *
     * @param response - The chosen action.
     * @returns True when acknowledged.
     */
    respondClose(response: ConfirmCloseResponse): Promise<boolean>;
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
     * Subscribe to app-menu action events.
     *
     * @param callback - Invoked for File-menu actions.
     * @returns Unsubscribe function.
     */
    onAction(callback: (payload: MenuActionPayload) => void): () => void;
  };
}
