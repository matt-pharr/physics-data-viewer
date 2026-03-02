/**
 * pdv.d.ts — renderer-facing preload API contract.
 *
 * Declares the typed `window.pdv` surface exposed by `electron/preload.ts`.
 * Renderer code imports from this file (via `types/index.ts`) and never imports
 * directly from main-process modules.
 */

/** Script `run(...)` parameter metadata returned for script tree nodes. */
export interface ScriptParameter {
  /** Parameter name as declared in script function signature. */
  name: string;
  /** Backend-normalized type label (e.g. "int", "float", "str"). */
  type: string;
  /** Default value extracted from script signature, when present. */
  default: unknown;
  /** True when this parameter must be provided by the caller. */
  required: boolean;
}

/** Tree node descriptor returned by `pdv.tree.list`. */
export interface NodeDescriptor {
  /** Stable node identifier. */
  id: string;
  /** Dot-delimited logical path in PDV tree namespace. */
  path: string;
  /** Node key (final path segment). */
  key: string;
  /** Parent path, or null for root-level nodes. */
  parent_path: string | null;
  /** Node kind (script, ndarray, dict, folder, ...). */
  type: string;
  /** True if node has children that can be listed/expanded. */
  has_children: boolean;
  /** True if file-backed value is lazy-loaded in kernel. */
  lazy: boolean;
  /** Human-readable preview text for compact table display. */
  preview?: string;
  /** Optional language hint for script/code nodes. */
  language?: string | null;
  /** Script parameter descriptors when `type === "script"`. */
  params?: ScriptParameter[] | undefined;
}

/** Runtime kernel descriptor returned by `kernels.start/list/restart`. */
export interface KernelInfo {
  /** Opaque kernel id used in subsequent API calls. */
  id: string;
  /** Kernel display name shown in UI/status. */
  name: string;
  /** Language mode currently bound to this kernel. */
  language: "python" | "julia";
  /** Current lifecycle state reported by backend manager. */
  status: "idle" | "busy" | "starting" | "error" | "dead";
}

/** Optional kernel launch override used by `kernels.start`. */
export interface KernelSpec {
  /** Kernel internal name/id. */
  name?: string;
  /** Human-readable display name. */
  displayName?: string;
  /** Kernel language mode. */
  language?: "python" | "julia";
  /** Full argv launch command (advanced override). */
  argv?: string[];
  /** Extra environment variables for spawned kernel process. */
  env?: Record<string, string>;
}

/** Execute request payload sent to `kernels.execute`. */
export interface KernelExecuteRequest {
  /** User code string to execute in the active kernel. */
  code: string;
  /** If true, suppresses normal display side-effects/history where applicable. */
  silent?: boolean;
  /** Caller-supplied ID to correlate streamed output chunks with this execution. */
  executionId?: string;
}

/** Streamed output fragment delivered over `kernels.onOutput`. */
export interface ExecuteOutputChunk {
  /** Caller-provided correlation id from execute request. */
  executionId: string;
  /** Output channel for this chunk. */
  type: "stdout" | "stderr" | "image" | "result";
  /** Text payload for stdout/stderr chunks. */
  text?: string;
  /** Image payload for display-data chunks. */
  image?: { mime: string; data: string };
  /** Structured execute-result payload, when available. */
  result?: unknown;
}

/** Final execute response resolved from `kernels.execute`. */
export interface KernelExecuteResult {
  stdout?: string;
  stderr?: string;
  result?: unknown;
  error?: string;
  duration?: number;
  /** Inline images captured from display_data iopub messages (Agg fallback). */
  images?: Array<{ mime: string; data: string }>;
}

/** Filters accepted by namespace query requests. */
export interface NamespaceQueryOptions {
  /** Include `_private` variable names when true. */
  includePrivate?: boolean;
  /** Include module objects in results when true. */
  includeModules?: boolean;
  /** Include callable values (functions/classes) when true. */
  includeCallables?: boolean;
}

/** One row in the Namespace panel. */
export interface NamespaceVariable {
  name: string;
  type: string;
  module?: string;
  shape?: number[];
  dtype?: string;
  length?: number;
  size?: number;
  preview?: string;
}

/** Custom appearance theme payload persisted through `themes.*` API. */
export interface Theme {
  name: string;
  colors: Record<string, string>;
}

/** Persisted code-cell tab state stored by `codeCells.*` API. */
export interface CodeCellData {
  /** Ordered tab list with code content and optional display name. */
  tabs: Array<{ id: number; code: string; name?: string }>;
  /** Active tab id to restore on startup/load. */
  activeTabId: number;
}

/** File-menu action event payload emitted by `menu.onAction`. */
export interface MenuActionPayload {
  /** Discriminated menu action identifier. */
  action: "project:open" | "project:openRecent" | "project:save" | "project:saveAs";
  /** Optional path argument for path-bearing menu actions. */
  path?: string;
}

/** Persisted user configuration payload returned by `config.get`. */
export interface Config {
  /** Kernel spec name used for launch defaults. */
  kernelSpec?: string | null;
  /** Working directory path (if tracked in config). */
  cwd?: string;
  /** Whether current project is trusted for script execution. */
  trusted?: boolean;
  /** Most-recent project paths for menu quick access. */
  recentProjects?: string[];
  /** Custom kernel definitions (legacy/advanced). */
  customKernels?: unknown[];
  /** Python executable configured by user. */
  pythonPath?: string;
  /** Julia executable configured by user. */
  juliaPath?: string;
  /** External editor command map (legacy). */
  editors?: Record<string, string>;
  /** Project root path (when persisted). */
  projectRoot?: string;
  /** Tree root path (when persisted). */
  treeRoot?: string;
  /** Namespace visibility toggle for private variables. */
  showPrivateVariables?: boolean;
  /** Namespace visibility toggle for module values. */
  showModuleVariables?: boolean;
  /** Namespace visibility toggle for callables. */
  showCallableVariables?: boolean;
  /** Coarse light/dark mode override. */
  theme?: "light" | "dark";
  /** External editor command for Python scripts. Uses `{}` as file-path placeholder. */
  pythonEditorCmd?: string;
  /** External editor command for Julia scripts. Uses `{}` as file-path placeholder. */
  juliaEditorCmd?: string;
  /** File-manager command to reveal a file/folder. Uses `{}` as placeholder. */
  fileManagerCmd?: string;
  settings?: {
    /** Keyboard shortcut overrides. */
    shortcuts?: {
      openSettings?: string;
      execute?: string;
      treeCopyPath?: string;
      treeEditScript?: string;
      treePrint?: string;
    };
    appearance?: {
      themeName?: string;
      colors?: Record<string, string>;
      followSystemTheme?: boolean;
      darkTheme?: string;
      lightTheme?: string;
    };
    editor?: {
      fontSize?: number;
      tabSize?: number;
      wordWrap?: boolean;
    };
    fonts?: {
      codeFont?: string;
      displayFont?: string;
    };
  };
}

/** Supported module install source kinds. */
export type ModuleSourceType = "github" | "local";

/** Canonical source reference for module install metadata. */
export interface ModuleSourceReference {
  type: ModuleSourceType;
  location: string;
}

/** Global installed module descriptor returned by `modules.listInstalled`. */
export interface ModuleDescriptor {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: ModuleSourceReference;
  revision?: string;
  installPath?: string;
}

/** Request payload for `modules.install`. */
export interface ModuleInstallRequest {
  source: ModuleSourceReference;
}

/** Result payload for `modules.install`. */
export interface ModuleInstallResult {
  success: boolean;
  status: "installed" | "up_to_date" | "update_available" | "incompatible_update" | "not_implemented" | "error";
  module?: ModuleDescriptor;
  currentVersion?: string;
  currentRevision?: string;
  error?: string;
}

/** Result payload for `modules.checkUpdates`. */
export interface ModuleUpdateResult {
  moduleId: string;
  status: "up_to_date" | "update_available" | "unknown" | "not_implemented";
  currentVersion?: string;
  availableVersion?: string;
  message?: string;
}

/** Request payload for importing a module into the active project. */
export interface ModuleImportRequest {
  moduleId: string;
  alias?: string;
}

/** Result payload for `modules.importToProject`. */
export interface ModuleImportResult {
  success: boolean;
  status: "imported" | "conflict" | "not_implemented" | "error";
  alias?: string;
  suggestedAlias?: string;
  warnings?: ModuleHealthWarning[];
  error?: string;
}

/** Declarative input field descriptor from module manifest. */
export interface ModuleInputDescriptor {
  id: string;
  label: string;
  type?: string;
  default?: string;
}

/** Declarative imported-module action descriptor for renderer controls. */
export interface ImportedModuleActionDescriptor {
  id: string;
  label: string;
  scriptName: string;
  inputIds?: string[];
}

/** Non-blocking module health warning surfaced to the renderer. */
export interface ModuleHealthWarning {
  code:
    | "pdv_version_incompatible"
    | "python_version_incompatible"
    | "python_version_unknown"
    | "dependency_unverified"
    | "missing_action_script"
    | "module_source_missing";
  message: string;
}

/** Project-scoped imported module descriptor. */
export interface ImportedModuleDescriptor {
  moduleId: string;
  name: string;
  alias: string;
  version: string;
  revision?: string;
  inputs: ModuleInputDescriptor[];
  actions: ImportedModuleActionDescriptor[];
  settings: Record<string, unknown>;
  warnings: ModuleHealthWarning[];
}

/** Request payload for `modules.saveSettings`. */
export interface ModuleSettingsRequest {
  moduleAlias: string;
  values: Record<string, unknown>;
}

/** Result payload for `modules.saveSettings`. */
export interface ModuleSettingsResult {
  success: boolean;
  error?: string;
}

/** Request payload for `modules.runAction`. */
export interface ModuleActionRequest {
  kernelId: string;
  moduleAlias: string;
  actionId: string;
  /** Input values keyed by input id (from the module's input fields). */
  inputValues?: Record<string, string>;
}

/** Result payload for `modules.runAction`. */
export interface ModuleActionResult {
  success: boolean;
  status: "queued" | "not_implemented" | "error";
  executionCode?: string;
  error?: string;
}

/** Complete preload API contract exposed as `window.pdv`. */
export interface PDVApi {
  kernels: {
    list(): Promise<KernelInfo[]>;
    start(spec?: Partial<KernelSpec>): Promise<KernelInfo>;
    stop(kernelId: string): Promise<boolean>;
    execute(kernelId: string, request: KernelExecuteRequest): Promise<KernelExecuteResult>;
    interrupt(kernelId: string): Promise<boolean>;
    restart(kernelId: string): Promise<KernelInfo>;
    complete(
      kernelId: string,
      code: string,
      cursorPos: number
    ): Promise<{ matches: string[]; cursor_start: number; cursor_end: number }>;
    inspect(
      kernelId: string,
      code: string,
      cursorPos: number
    ): Promise<{ found: boolean; data?: Record<string, string> }>;
    validate(
      executablePath: string,
      language: "python" | "julia"
    ): Promise<{ valid: boolean; error?: string }>;
    onOutput(callback: (chunk: ExecuteOutputChunk) => void): () => void;
  };
  tree: {
    list(kernelId: string, path?: string): Promise<NodeDescriptor[]>;
    get(kernelId: string, path: string): Promise<Record<string, unknown>>;
    createScript(
      kernelId: string,
      targetPath: string,
      scriptName: string
    ): Promise<{ success: boolean; error?: string; scriptPath?: string }>;
    onChanged(
      callback: (payload: { changed_paths: string[]; change_type: "added" | "removed" | "updated" }) => void
    ): () => void;
  };
  namespace: {
    query(kernelId: string, options?: NamespaceQueryOptions): Promise<NamespaceVariable[]>;
  };
  script: {
    edit(kernelId: string, scriptPath: string): Promise<{ success: boolean; error?: string }>;
    reload(scriptPath: string): Promise<{ success: boolean; error?: string }>;
  };
  modules: {
    listInstalled(): Promise<ModuleDescriptor[]>;
    install(request: ModuleInstallRequest): Promise<ModuleInstallResult>;
    checkUpdates(moduleId: string): Promise<ModuleUpdateResult>;
    importToProject(request: ModuleImportRequest): Promise<ModuleImportResult>;
    listImported(): Promise<ImportedModuleDescriptor[]>;
    saveSettings(request: ModuleSettingsRequest): Promise<ModuleSettingsResult>;
    runAction(request: ModuleActionRequest): Promise<ModuleActionResult>;
    removeImport(moduleAlias: string): Promise<ModuleSettingsResult>;
  };
  project: {
    save(saveDir: string, codeCells: unknown): Promise<boolean>;
    load(saveDir: string): Promise<unknown>;
    new(): Promise<boolean>;
    onLoaded(callback: (payload: Record<string, unknown>) => void): () => void;
  };
  config: {
    get(): Promise<Config>;
    set(updates: Partial<Config>): Promise<Config>;
  };
  about: {
    getVersion(): Promise<string>;
  };
  themes: {
    get(): Promise<Theme[]>;
    save(theme: Theme): Promise<boolean>;
  };
  codeCells: {
    load(): Promise<CodeCellData | null>;
    save(data: CodeCellData): Promise<boolean>;
  };
  files: {
    pickExecutable(): Promise<string | null>;
    pickDirectory(): Promise<string | null>;
  };
  lifecycle: {
    onConfirmClose(callback: () => void): () => void;
    respondClose(response: { action: 'save' | 'discard' | 'cancel' }): Promise<boolean>;
  };
  menu: {
    updateRecentProjects(paths: string[]): Promise<boolean>;
    onAction(callback: (payload: MenuActionPayload) => void): () => void;
  };
}

declare global {
  interface Window {
    pdv: PDVApi;
  }
}

export {};
