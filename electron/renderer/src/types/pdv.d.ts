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
  /** Physical filename with extension for file-backed nodes (e.g. "run.nml"). Null for others. */
  filename?: string | null;
  /** Fully qualified Python type string (e.g. "builtins.int"). */
  python_type?: string;
  /** True if a custom handler is registered for this node's type. */
  has_handler?: boolean;
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

/** Execution source metadata attached to execute requests/results. */
export interface KernelExecutionOrigin {
  kind: "code-cell" | "tree-script" | "unknown";
  label?: string;
  tabId?: number;
  scriptPath?: string;
}

/** Parsed traceback location metadata surfaced in execution errors. */
export interface KernelExecutionLocation {
  file?: string;
  line?: number;
  column?: number;
}

/** Structured execution error details returned by `kernels.execute`. */
export interface KernelExecutionError {
  name: string;
  message: string;
  summary: string;
  traceback: string[];
  location?: KernelExecutionLocation;
  source?: KernelExecutionOrigin;
}

/** Execute request payload sent to `kernels.execute`. */
export interface KernelExecuteRequest {
  /** User code string to execute in the active kernel. */
  code: string;
  /** If true, suppresses normal display side-effects/history where applicable. */
  silent?: boolean;
  /** Caller-supplied ID to correlate streamed output chunks with this execution. */
  executionId?: string;
  /** Optional execution-origin context used for traceback summaries. */
  origin?: KernelExecutionOrigin;
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
  errorDetails?: KernelExecutionError;
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
  action: "project:open" | "project:openRecent" | "project:save" | "project:saveAs" | "modules:import";
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

export type ModuleInputValue = string | number | boolean;

export interface ModuleInputOptionDescriptor {
  label: string;
  value: ModuleInputValue;
}

export interface ModuleInputVisibilityRule {
  inputId: string;
  equals: ModuleInputValue;
}

/** Declarative input field descriptor from module manifest. */
export interface ModuleInputDescriptor {
  id: string;
  label: string;
  type?: string;
  control?: "text" | "dropdown" | "slider" | "checkbox" | "file";
  default?: ModuleInputValue;
  options?: ModuleInputOptionDescriptor[];
  optionsTreePath?: string;
  min?: number;
  max?: number;
  step?: number;
  tab?: string;
  section?: string;
  sectionCollapsed?: boolean;
  tooltip?: string;
  visibleIf?: ModuleInputVisibilityRule;
  fileMode?: "file" | "directory";
}

/** Declarative imported-module action descriptor for renderer controls. */
export interface ImportedModuleActionDescriptor {
  id: string;
  label: string;
  scriptName: string;
  inputIds?: string[];
  tab?: string;
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

/** Request payload for opening a module popup window. */
export interface ModuleWindowOpenRequest {
  alias: string;
  kernelId: string;
}

/** Result payload for `moduleWindows.open`. */
export interface ModuleWindowOpenResult {
  success: boolean;
  error?: string;
}

/** Context payload identifying a module popup window. */
export interface ModuleWindowContext {
  alias: string;
  kernelId: string;
}

/** Reference to an input in the container layout. */
export interface LayoutInputRef {
  type: "input";
  id: string;
}

/** Reference to an action in the container layout. */
export interface LayoutActionRef {
  type: "action";
  id: string;
}

/** A layout container that arranges children visually. */
export interface LayoutContainer {
  type: "row" | "column" | "group" | "tabs";
  label?: string;
  collapsed?: boolean;
  children: LayoutNode[];
}

/** A layout node is either an input reference, action reference, or a container. */
export type LayoutNode = LayoutInputRef | LayoutActionRef | LayoutContainer;

/** Top-level GUI layout object in the module manifest. */
export interface ModuleGuiLayout {
  layout: LayoutContainer;
}

/** Project-scoped imported module descriptor. */
export interface ImportedModuleDescriptor {
  moduleId: string;
  name: string;
  alias: string;
  version: string;
  revision?: string;
  hasGui: boolean;
  inputs: ModuleInputDescriptor[];
  actions: ImportedModuleActionDescriptor[];
  gui?: ModuleGuiLayout;
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
  /**
   * Input values keyed by input id (from the module's input fields).
   *
   * Note: string values are sent as Python expression text; provide
   * language-safe strings (quote string literals).
   */
  inputValues?: Record<string, ModuleInputValue>;
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
    ): Promise<{
      matches: string[];
      cursor_start: number;
      cursor_end: number;
      metadata?: Record<string, unknown>;
    }>;
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
    createNote(
      kernelId: string,
      targetPath: string,
      noteName: string
    ): Promise<{ success: boolean; error?: string; notePath?: string; treePath?: string }>;
    addFile(
      kernelId: string,
      sourcePath: string,
      targetTreePath: string,
      nodeType: "namelist" | "fortran" | "file",
      filename: string
    ): Promise<{ success: boolean; error?: string; workingDirPath?: string }>;
    invokeHandler(
      kernelId: string,
      path: string
    ): Promise<{ success: boolean; error?: string }>;
    onChanged(
      callback: (payload: { changed_paths: string[]; change_type: "added" | "removed" | "updated" }) => void
    ): () => void;
  };
  namespace: {
    query(kernelId: string, options?: NamespaceQueryOptions): Promise<NamespaceVariable[]>;
  };
  script: {
    edit(kernelId: string, scriptPath: string): Promise<{ success: boolean; error?: string }>;
  };
  note: {
    save(kernelId: string, treePath: string, content: string): Promise<{ success: boolean; error?: string }>;
    read(kernelId: string, treePath: string): Promise<{ success: boolean; content?: string; error?: string }>;
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
  moduleWindows: {
    open(request: ModuleWindowOpenRequest): Promise<ModuleWindowOpenResult>;
    close(alias: string): Promise<boolean>;
    context(): Promise<ModuleWindowContext | null>;
    executeInMain(code: string): Promise<void>;
    onExecuteRequest(callback: (code: string) => void): () => void;
  };
  files: {
    pickExecutable(): Promise<string | null>;
    pickFile(): Promise<string | null>;
    pickDirectory(): Promise<string | null>;
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
