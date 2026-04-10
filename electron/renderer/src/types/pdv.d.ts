/**
 * pdv.d.ts — renderer-facing preload API contract.
 *
 * Declares the typed `window.pdv` surface exposed by `electron/preload.ts`.
 * Renderer code imports from this file (via `types/index.ts`) and never imports
 * directly from main-process modules.
 *
 * This file MAY use `import type` from `../../../main/ipc` (and transitively
 * `pdv-protocol.ts`) to keep wire/IPC types in lockstep with the main-process
 * source of truth. Type-only imports erase at compile time and do not create
 * any runtime cross-process boundary violation.
 */

/** Auto-update status pushed from the main process. */
export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  version?: string;
  progress?: number;
  error?: string;
  releaseUrl?: string;
  canAutoUpdate?: boolean;
}

// ---------------------------------------------------------------------------
// Wire types re-exported from main/ipc.ts (canonical source: pdv-protocol.ts)
// ---------------------------------------------------------------------------

/** Script `run(...)` parameter metadata. Canonical: `pdv-protocol.ts`. */
export type { ScriptParameter } from '../../../main/ipc';

/** Tree node descriptor returned by `pdv.tree.list`. Canonical: `pdv-protocol.ts`. */
export type { NodeDescriptor } from '../../../main/ipc';

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

// ---------------------------------------------------------------------------
// Namespace inspector types re-exported from main/ipc.ts.
// ---------------------------------------------------------------------------

/** Filters accepted by namespace query requests. */
export type { NamespaceQueryOptions } from '../../../main/ipc';

/** Serializable selector used to drill into a namespace value. */
export type { NamespaceAccessSegment } from '../../../main/ipc';

/** Target value for lazy namespace inspection. */
export type { NamespaceInspectTarget } from '../../../main/ipc';

/** One row in the Namespace panel. */
export type { NamespaceInspectorNode } from '../../../main/ipc';

/** One top-level row in the Namespace panel. */
export type { NamespaceVariable } from '../../../main/ipc';

/** Lazy child-inspection response for a namespace node. */
export type { NamespaceInspectResult } from '../../../main/ipc';

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
  action: "project:new" | "project:open" | "project:openRecent" | "project:save" | "project:saveAs" | "recentProjects:clear" | "modules:import" | "settings:open";
  /** Optional path argument for path-bearing menu actions. */
  path?: string;
}

/** Partial map of menu item IDs to enabled/disabled state. */
export interface MenuEnabledState {
  "project:save"?: boolean;
  "project:saveAs"?: boolean;
  "modules:import"?: boolean;
}

/** Top-level menu metadata used by the Linux integrated menubar. */
export interface AppMenuTopLevel {
  id: "file" | "edit" | "view" | "window" | "help";
  label: string;
}

/** Platform string used by the renderer title-bar shell. */
export type WindowChromePlatform = "macos" | "linux" | "windows";

/** Main-window chrome information returned by the preload bridge. */
export interface WindowChromeInfo {
  platform: WindowChromePlatform;
  showCustomTitleBar: boolean;
  showMenuBar: boolean;
  showWindowControls: boolean;
  isMaximized: boolean;
}

/** Progress update payload pushed during save/load operations. */
export interface ProgressPayload {
  operation: "save" | "load";
  /** Short human-readable phase label (e.g. "Serializing", "Copying files"). */
  phase: string;
  current: number;
  total: number;
}

/** Result returned from `project.save()`. */
export interface ProjectSaveResult {
  /** SHA-256 checksum of the serialized tree-index.json. */
  checksum: string;
  /** Number of tree nodes serialized. */
  nodeCount: number;
  /** Project name stored in the manifest (may be absent for older projects). */
  projectName?: string;
}

/** Result returned from `project.load()`. */
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

/** Lightweight manifest peek returned before kernel start. */
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
  /** Whether the Namespace panel auto-refreshes on a polling interval. */
  autoRefreshNamespace?: boolean;
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
      execute?: string;
      newTab?: string;
      closeTab?: string;
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
export type ModuleSourceType = "github" | "local" | "bundled";

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
  language?: "python" | "julia";
  source: ModuleSourceReference;
  revision?: string;
  installPath?: string;
  upstream?: string;
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

/** Result payload for `modules.uninstall`. */
export interface ModuleUninstallResult {
  success: boolean;
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

/** Result returned by `namelist.read`. */
export interface NamelistReadResult {
  groups: Record<string, Record<string, unknown>>;
  hints: Record<string, Record<string, string>>;
  types: Record<string, Record<string, string>>;
  format: "fortran" | "toml";
}

/** Result returned by `namelist.write`. */
export interface NamelistWriteResult {
  success: boolean;
  error?: string;
}

/** Request payload for `script.run`. */
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

/** Result returned by `script.run`. */
export interface ScriptRunResult {
  /** The exact code string sent to the kernel (for console display). */
  code: string;
  /** Echo of the caller-supplied execution ID. */
  executionId: string;
  /** Echo of the caller-supplied origin metadata. */
  origin: KernelExecutionOrigin;
  /** Structured execution result from the kernel. */
  result: KernelExecuteResult;
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

/** Reference to a namelist file in the tree, rendered as an inline editor. */
export interface LayoutNamelistRef {
  type: "namelist";
  tree_path: string;
  tree_path_input?: string;
}

/** A layout node is either an input reference, action reference, namelist reference, or a container. */
export type LayoutNode = LayoutInputRef | LayoutActionRef | LayoutNamelistRef | LayoutContainer;

/** Top-level GUI layout object in the module manifest. */
export interface ModuleGuiLayout {
  layout: LayoutContainer;
}

/** Action descriptor as stored on disk in gui.json. */
export interface GuiActionDescriptor {
  id: string;
  label: string;
  script_path: string;
  inputs?: string[];
}

/** Complete GUI manifest as stored in .gui.json files. */
export interface GuiManifestV1 {
  has_gui: boolean;
  gui?: ModuleGuiLayout;
  inputs: ModuleInputDescriptor[];
  actions: GuiActionDescriptor[];
}

/** Request payload for opening a GUI editor window. */
export interface GuiEditorOpenRequest {
  treePath: string;
  kernelId: string;
}

/** Result payload for `guiEditor.open`. */
export interface GuiEditorOpenResult {
  success: boolean;
  error?: string;
}

/** Context payload identifying a GUI editor window. */
export interface GuiEditorContext {
  treePath: string;
  kernelId: string;
}

/** Result payload for `guiEditor.read`. */
export interface GuiEditorReadResult {
  success: boolean;
  manifest?: GuiManifestV1;
  error?: string;
}

/** Request payload for `guiEditor.save`. */
export interface GuiEditorSaveRequest {
  treePath: string;
  manifest: GuiManifestV1;
}

/** Result payload for `guiEditor.save`. */
export interface GuiEditorSaveResult {
  success: boolean;
  error?: string;
}

/** Result returned by `tree.createGui`. */
export interface TreeCreateGuiResult {
  success: boolean;
  error?: string;
  guiPath?: string;
  treePath?: string;
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

/** Enriched environment descriptor with package installation status. */
export interface EnvironmentInfo {
  kind: "conda" | "venv" | "pyenv" | "system" | "configured";
  pythonPath: string;
  label: string;
  pythonVersion: string;
  pdvInstalled: boolean;
  pdvVersion: string | null;
  pdvCompatible: boolean;
  pdvVersionMismatch: boolean;
  ipykernelInstalled: boolean;
}

/** Result of a streaming pip install operation. */
export interface EnvironmentInstallResult {
  success: boolean;
  output: string;
}

/** A single streaming output chunk from a pip install operation. */
export interface InstallOutputChunk {
  stream: "stdout" | "stderr";
  data: string;
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
    onKernelCrashed(callback: (payload: { kernelId: string }) => void): () => void;
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
    createGui(
      kernelId: string,
      targetPath: string,
      guiName: string
    ): Promise<TreeCreateGuiResult>;
    addFile(
      kernelId: string,
      sourcePath: string,
      targetTreePath: string,
      nodeType: "namelist" | "lib" | "file",
      filename: string
    ): Promise<{ success: boolean; error?: string; workingDirPath?: string }>;
    invokeHandler(
      kernelId: string,
      path: string
    ): Promise<{ success: boolean; error?: string }>;
    delete(
      kernelId: string,
      treePath: string
    ): Promise<{ success: boolean; error?: string }>;
    onChanged(
      callback: (payload: { changed_paths: string[]; change_type: "added" | "removed" | "updated" | "batch" }) => void
    ): () => void;
  };
  namespace: {
    query(kernelId: string, options?: NamespaceQueryOptions): Promise<NamespaceVariable[]>;
    inspect(kernelId: string, target: NamespaceInspectTarget): Promise<NamespaceInspectResult>;
  };
  script: {
    run(kernelId: string, request: ScriptRunRequest): Promise<ScriptRunResult>;
    edit(kernelId: string, scriptPath: string): Promise<{ success: boolean; error?: string }>;
    getParams(kernelId: string, treePath: string): Promise<ScriptParameter[]>;
  };
  note: {
    save(kernelId: string, treePath: string, content: string): Promise<{ success: boolean; error?: string }>;
    read(kernelId: string, treePath: string): Promise<{ success: boolean; content?: string; error?: string }>;
  };
  namelist: {
    read(kernelId: string, treePath: string): Promise<NamelistReadResult>;
    write(kernelId: string, treePath: string, data: Record<string, Record<string, unknown>>): Promise<NamelistWriteResult>;
  };
  environment: {
    list(): Promise<EnvironmentInfo[]>;
    check(pythonPath: string): Promise<EnvironmentInfo | null>;
    install(pythonPath: string): Promise<EnvironmentInstallResult>;
    refresh(): Promise<EnvironmentInfo[]>;
    onInstallOutput(callback: (chunk: InstallOutputChunk) => void): () => void;
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
    uninstall(moduleId: string): Promise<ModuleUninstallResult>;
    update(moduleId: string): Promise<ModuleInstallResult>;
  };
  project: {
    save(saveDir: string, codeCells: unknown, projectName?: string): Promise<ProjectSaveResult>;
    load(saveDir: string): Promise<ProjectLoadResult>;
    new(): Promise<boolean>;
    peekLanguages(paths: string[]): Promise<Record<string, "python" | "julia">>;
    peekManifest(dir: string): Promise<ProjectManifestPeek>;
    onLoaded(callback: (payload: Record<string, unknown>) => void): () => void;
    onReloading(callback: (payload: { status: "reloading" | "ready" }) => void): () => void;
  };
  progress: {
    onProgress(callback: (payload: ProgressPayload) => void): () => void;
  };
  config: {
    get(): Promise<Config>;
    set(updates: Partial<Config>): Promise<Config>;
  };
  about: {
    getVersion(): Promise<string>;
  };
  updater: {
    checkForUpdates(): Promise<void>;
    downloadUpdate(): Promise<void>;
    installUpdate(): Promise<void>;
    openReleasesPage(): Promise<void>;
    onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  };
  themes: {
    get(): Promise<Theme[]>;
    save(theme: Theme): Promise<boolean>;
    openDir(): Promise<string>;
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
  guiEditor: {
    open(request: GuiEditorOpenRequest): Promise<GuiEditorOpenResult>;
    openViewer(request: GuiEditorOpenRequest): Promise<GuiEditorOpenResult>;
    context(): Promise<GuiEditorContext | null>;
    read(treePath: string): Promise<GuiEditorReadResult>;
    save(request: GuiEditorSaveRequest): Promise<GuiEditorSaveResult>;
  };
  files: {
    pickExecutable(): Promise<string | null>;
    pickFile(): Promise<string | null>;
    pickDirectory(defaultPath?: string): Promise<string | null>;
  };
  menu: {
    updateRecentProjects(paths: string[]): Promise<boolean>;
    updateEnabled(state: MenuEnabledState): Promise<boolean>;
    getModel(): Promise<AppMenuTopLevel[]>;
    popup(menuId: AppMenuTopLevel["id"], x: number, y: number): Promise<boolean>;
    onAction(callback: (payload: MenuActionPayload) => void): () => void;
  };
  chrome: {
    getInfo(): Promise<WindowChromeInfo>;
    minimize(): Promise<boolean>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<boolean>;
    onStateChanged(callback: (info: WindowChromeInfo) => void): () => void;
  };
  app: {
    /** Confirm the renderer has approved closing the main window. */
    confirmClose(): Promise<void>;
    /**
     * Subscribe to "user is trying to close" notifications. Fires for both
     * the title-bar close button and OS-level window close (Cmd+Q, Alt+F4).
     */
    onRequestClose(callback: () => void): () => void;
  };
}

declare global {
  interface Window {
    pdv: PDVApi;
  }
}

export {};
