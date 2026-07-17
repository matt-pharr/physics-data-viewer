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

/** Periodic kernel-memory snapshot pushed on `IPC.push.kernelMemory`. */
export type { KernelMemoryPayload } from '../../../main/ipc';

/** Terminal-emulator preset identifier for the launchers config. */
export type { TerminalPreset } from '../../../main/ipc';

/** Persisted terminal-launcher selection (`launchers.terminal`). */
export type { TerminalLauncherConfig } from '../../../main/ipc';

/** Persisted editor / IDE launcher config (`launchers.editor`). */
export type { EditorLauncherConfig } from '../../../main/ipc';

/** Persisted AI-agent launcher config (`launchers.agent`). */
export type { AgentLauncherConfig } from '../../../main/ipc';

/** Launcher availability-check descriptor for `launchers.checkAvailability`. */
export type { LauncherCheck } from '../../../main/ipc';

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
  kind: "code-cell" | "tree-script" | "agent" | "unknown";
  label?: string;
  tabId?: number;
  scriptPath?: string;
  /** MCP tool name when `kind === "agent"` (e.g. "pdv_run", "script_run"). */
  agentTool?: string;
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
  action: "project:new" | "project:open" | "project:openRecent" | "project:save" | "project:saveAs" | "recentProjects:clear" | "modules:import" | "modules:newEmpty" | "settings:open";
  /** Optional path argument for path-bearing menu actions. */
  path?: string;
}

/** Partial map of menu item IDs to enabled/disabled state. */
export interface MenuEnabledState {
  "project:save"?: boolean;
  "project:saveAs"?: boolean;
  "modules:import"?: boolean;
  "modules:newEmpty"?: boolean;
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
  /** Tree paths of file-backed nodes whose backing files were missing during save. */
  missingFiles?: string[];
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
  /** Tree paths of file-backed nodes whose files were missing from the save directory. */
  missingFiles?: string[];
  /**
   * Warning from re-pointing a running uv session's environment at the
   * opened project (e.g. Python-pin mismatch or a failed `uv sync`).
   */
  envSyncWarning?: string;
  /**
   * Present when a pkg-mode Julia project was resolved with a different
   * Julia minor than the session is running (§10.7.5). The load itself
   * always proceeds.
   */
  juliaVersionCheck?: JuliaVersionLoadCheck;
}

/** Lightweight manifest peek returned before kernel start. */
/** Per-project environment configuration (§10.5 uv / §10.6 Julia pkg). */
export interface EnvironmentConfig {
  /** Which environment flow this project uses. */
  mode: "uv" | "shared" | "pkg";
  /** Requested Python version for uv mode (e.g. "3.12"). */
  python_version?: string;
  /** Julia version the session ran on, pkg mode only (e.g. "1.11.6"). */
  julia_version?: string;
}

export interface ProjectManifestPeek {
  /** Kernel language used by this project. */
  language: "python" | "julia";
  /** Interpreter path saved with the project, if any. */
  interpreterPath?: string;
  /** PDV version the project was saved with. */
  pdvVersion?: string;
  /** Project name stored in the manifest. */
  projectName?: string;
  /** Per-project environment configuration (§10.5). Absent on legacy manifests. */
  environment?: EnvironmentConfig;
}

/**
 * Extra context passed to `kernels.start` when opening a per-project-
 * environment session — for Python, materialize the uv environment and
 * launch against the venv interpreter (§10.5.9); for Julia, seed the
 * project's `Project.toml`/`Manifest.toml`, activate via `JULIA_PROJECT`,
 * and `Pkg.instantiate` (§10.6).
 */
export interface KernelUvContext {
  /** Opening an existing uv/pkg project: its save directory. */
  saveDir?: string;
  /** Creating a brand-new project (§10.5.8 Python / §10.6.5 Julia). */
  newProject?: boolean;
  /**
   * Python version for a new project's venv (e.g. `"3.13"`), chosen in the
   * New Project dialog. Only meaningful with `newProject`.
   */
  pythonVersion?: string;
  /**
   * Initial dependency specs for a new project, chosen in the New Project
   * dialog: PEP 508 specs (Python) or package names with optional
   * `Name@version` pins (Julia). Only meaningful with `newProject`.
   */
  packages?: string[];
  /**
   * Julia minor for a new pkg-mode project (e.g. `"1.10"`), chosen in the
   * New Julia Project dialog (§10.6.5). The main process acquires it with
   * juliaup and installs PDVKernel into it as needed before the kernel
   * spawns. Only meaningful with `newProject`.
   */
  juliaVersion?: string;
}

/**
 * Result of `kernels.restart`: the freshly started kernel plus whether
 * project state was restored from a pre-restart autosave snapshot.
 */
export interface KernelRestartResult {
  /** Metadata of the newly started kernel. */
  kernel: KernelInfo;
  /** True when tree/cell state was reloaded from an autosave snapshot. */
  restoredFromAutosave: boolean;
}

/**
 * Environment metadata for the active kernel (Project Environment tab).
 */
export interface ActiveEnvironmentInfo {
  /**
   * Whether the session runs in a uv-managed project venv (`'uv'`), a
   * Pkg-managed Julia project environment (`'pkg'`, §10.6), or a shared env.
   */
  mode: 'uv' | 'shared' | 'pkg';
  /** Interpreter the kernel actually spawned on (venv python for uv mode). */
  interpreterPath?: string;
  /** Resolved `major.minor` Python version of that interpreter. */
  pythonVersion?: string;
  /** Resolved Julia version of the session, pkg mode only (e.g. "1.11.6"). */
  juliaVersion?: string;
}

/**
 * One row of the Packages UI (§10.5.13): a project dependency paired with
 * the version actually installed in the venv (when present).
 */
export interface ProjectPackage {
  /** PEP 508 specifier as written in `[project].dependencies`. */
  spec: string;
  /** Distribution name normalized per PEP 503. */
  name: string;
  /** Version reported by `uv pip list`, or undefined if not installed. */
  installedVersion?: string;
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
  /** Python executable configured by user. */
  pythonPath?: string;
  /** Julia executable configured by user. */
  juliaPath?: string;
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
  /** @deprecated Superseded by `launchers.editor.fileCommand` (migrated on load). */
  pythonEditorCmd?: string;
  /** @deprecated Superseded by `launchers.editor.fileCommand` (migrated on load). */
  juliaEditorCmd?: string;
  /** Default parent directory for new project saves (pre-fills Save As dialog). */
  defaultSaveLocation?: string;
  /** Base directory for session working directories. */
  workingDirBase?: string;
  /** Autosave interval in seconds. Default 300 (5 minutes). Minimum 30. */
  autoSaveIntervalSeconds?: number;
  /** Packages (PEP 508 specs) seeded into a new uv project. */
  defaultPackages?: string[];
  /** Local AI-agent MCP server settings, surfaced in the Agents tab. */
  mcp?: {
    /** Preferred TCP port for the MCP server to bind. */
    defaultPort?: number;
    /** Whether agents may use mutating (write) tools. Defaults to off. */
    mutatingToolsEnabled?: boolean;
    /** Whether agents may run code in the kernel via `pdv_run`. Defaults to off. */
    pdvRunEnabled?: boolean;
  };
  /** uv environment-manager settings. */
  uv?: {
    /** Absolute path to a `uv` binary overriding the bundled one. */
    binaryPath?: string;
  };
  /** Configurable external-app launchers (terminal wrap, editor, agent). */
  launchers?: {
    /** Terminal emulator used to wrap TUI editors (vim, nvim, …). */
    terminal?: TerminalLauncherConfig;
    /** Editor / IDE commands (supersedes `pythonEditorCmd`/`juliaEditorCmd`). */
    editor?: EditorLauncherConfig;
    /** AI-agent CLI launched by the action-bar agent button. */
    agent?: AgentLauncherConfig;
  };
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
    markdown?: {
      /** Max content width (px) for the read-mode rendered markdown view. */
      maxContentWidth?: number;
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

/** Request payload for `tree.print` (code string is built in main). */
export interface TreePrintRequest {
  /** Dot-delimited tree path of the node to print; "" prints the whole tree. */
  path: string;
  /** Caller-supplied execution ID for output correlation. */
  executionId: string;
  /** Execution origin metadata used in error summaries and the console. */
  origin: KernelExecutionOrigin;
}

/** Result returned by `script.run` (and `tree.print`, which shares the shape). */
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
  isFreeThreaded: boolean;
}

/**
 * A discovered Julia runtime with PDVKernel/IJulia status (§10.7).
 * Mirrors `JuliaRuntimeInfo` in `main/julia-discovery.ts`.
 */
export interface JuliaRuntimeInfo {
  kind: "juliaup" | "system" | "configured";
  /** Absolute path to the real Julia executable (never the juliaup shim). */
  juliaPath: string;
  label: string;
  juliaVersion: string | null;
  /** juliaup channel name; undefined for non-juliaup runtimes. */
  channel?: string;
  /** True when this is the juliaup default channel. */
  isDefault: boolean;
  pdvKernelInstalled: boolean;
  pdvKernelVersion: string | null;
  pdvKernelCompatible: boolean;
  pdvKernelVersionMismatch: boolean;
  ijuliaInstalled: boolean;
}

/**
 * A juliaup channel entry parsed from `juliaup.json` (§10.7.1).
 * Mirrors `JuliaupChannel` in `main/julia-discovery.ts`.
 */
export interface JuliaupChannel {
  /** Channel name (`"release"`, `"lts"`, `"1.10"`, a linked name, ...). */
  channel: string;
  /** Absolute path to the channel's Julia executable. */
  juliaPath: string;
  /** Version string (e.g. `"1.11.6"`), or null for linked channels. */
  version: string | null;
  /** True when this is the `Default` channel. */
  isDefault: boolean;
}

/**
 * Presence report for the user's juliaup installation (§10.7.5).
 * Mirrors `JuliaupStatus` in `main/juliaup-runner.ts`.
 */
export interface JuliaupStatus {
  /** True when a juliaup executable was found. */
  installed: boolean;
  /** Absolute path to the juliaup executable, or null when absent. */
  juliaupPath: string | null;
}

/**
 * Load-time Julia version assessment for a pkg-mode project (§10.7.5).
 * Mirrors `JuliaVersionLoadCheck` in `main/juliaup-runner.ts`.
 */
export interface JuliaVersionLoadCheck {
  /** `julia_version` recorded in the project's `Manifest.toml`. */
  manifestVersion: string;
  /** The juliaup channel that would provide it (`"1.10"`). */
  channel: string;
  /** Julia version the session is running, when known. */
  runningVersion?: string;
  /** True when an installed juliaup channel already provides that minor. */
  channelInstalled: boolean;
  /** True when juliaup itself is installed. */
  juliaupInstalled: boolean;
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
  /**
   * Optional launch-stage marker: `"kernel-boot"` is pushed (with empty
   * `data`) once the uv environment is materialized and the kernel process
   * is about to start, so the EnvSyncModal can retitle accordingly.
   */
  stage?: "kernel-boot";
}

/** Complete preload API contract exposed as `window.pdv`. */
/**
 * Status of the local AI-agent MCP server, surfaced to the Settings →
 * Agents pane. Mirrors `McpStatus` in `main/ipc.ts`.
 */
export interface McpStatus {
  /** Whether the MCP server is currently listening. */
  running: boolean;
  /** Loopback host the server binds to (always `127.0.0.1`). */
  host: string;
  /** TCP port the server listens on, or `null` when not running. */
  port: number | null;
  /** Bearer token every request must present, or `null` when not running. */
  token: string | null;
  /** Full endpoint URL an agent connects to, or `null` when not running. */
  url: string | null;
  /** Current project/kernel generation counter (diagnostic). */
  generation: number;
  /**
   * Number of currently-connected MCP client sessions. Returned by
   * `getStatus()` so renderers can seed `mcpClientAttached` on mount
   * without waiting for the next push.
   */
  clientCount: number;
}

/**
 * Push payload for `IPC.push.mcpClientStatus`. Mirrors
 * `McpClientStatusPayload` in `main/ipc.ts`.
 */
export interface McpClientStatusPayload {
  /** Number of currently-connected MCP client sessions. */
  clientCount: number;
}

/**
 * Cell-tool RPC payloads mirroring the types in `main/ipc.ts`. The main
 * process drives reads via `cellsRequest`/`respond` and writes via
 * `cellWrite` (ARCHITECTURE.md §15.8).
 */
export interface CellsRequestPush {
  requestId: string;
  op: "list" | "read";
  tabId?: number;
}

export interface CellListEntry {
  id: number;
  name?: string;
  length: number;
}

export interface CellListResult {
  tabs: CellListEntry[];
  activeTabId: number | null;
}

export interface CellReadResult {
  id: number;
  name?: string;
  code: string;
}

export interface CellsResponse {
  requestId: string;
  ok: boolean;
  result?: CellListResult | CellReadResult;
  error?: string;
}

/** Mirrors `ExecuteBeginPayload` in `main/ipc.ts`. */
export interface ExecuteBeginPayload {
  executionId: string;
  code: string;
  origin: KernelExecutionOrigin;
  timestamp: number;
}

/** Mirrors `ExecuteFinishPayload` in `main/ipc.ts`. */
export interface ExecuteFinishPayload {
  executionId: string;
  duration: number;
  error?: string;
  errorDetails?: KernelExecutionError;
}

export interface CellWritePush {
  tabId?: number;
  code: string;
  name?: string;
}

export interface PDVApi {
  kernels: {
    list(): Promise<KernelInfo[]>;
    start(spec?: Partial<KernelSpec>, uvContext?: KernelUvContext): Promise<KernelInfo>;
    stop(kernelId: string): Promise<boolean>;
    execute(kernelId: string, request: KernelExecuteRequest): Promise<KernelExecuteResult>;
    interrupt(kernelId: string): Promise<boolean>;
    restart(kernelId: string): Promise<KernelRestartResult>;
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
    onExecuteBegin(callback: (payload: ExecuteBeginPayload) => void): () => void;
    onExecuteFinish(callback: (payload: ExecuteFinishPayload) => void): () => void;
    onKernelCrashed(callback: (payload: { kernelId: string }) => void): () => void;
    onReconnected(callback: (payload: { kernelId: string }) => void): () => void;
    onMemory(callback: (payload: KernelMemoryPayload) => void): () => void;
  };
  tree: {
    list(kernelId: string, path?: string): Promise<NodeDescriptor[]>;
    get(kernelId: string, path: string): Promise<Record<string, unknown>>;
    createScript(
      kernelId: string,
      targetPath: string,
      scriptName: string
    ): Promise<{ success: boolean; error?: string; scriptPath?: string; treePath?: string }>;
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
    createLib(
      kernelId: string,
      targetPath: string,
      libName: string
    ): Promise<{ success: boolean; error?: string; libPath?: string; treePath?: string }>;
    createNode(
      kernelId: string,
      targetPath: string,
      nodeName: string
    ): Promise<{ success: boolean; error?: string; treePath?: string }>;
    rename(
      kernelId: string,
      treePath: string,
      newName: string
    ): Promise<{ success: boolean; error?: string; oldPath?: string; newPath?: string }>;
    move(
      kernelId: string,
      treePath: string,
      newPath: string,
    ): Promise<{ success: boolean; error?: string; oldPath?: string; newPath?: string }>;
    duplicate(
      kernelId: string,
      treePath: string,
      newPath: string,
    ): Promise<{ success: boolean; error?: string; newPath?: string }>;
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
    /**
     * Print a tree node's value in the kernel and return the run for
     * console logging (invocation string built in the main process).
     */
    print(kernelId: string, request: TreePrintRequest): Promise<ScriptRunResult>;
    onChanged(
      callback: (payload: { changed_paths: string[]; change_type: "added" | "removed" | "updated" | "batch" | "unknown" }) => void
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
    /** Streams `uv` output during a uv-project environment setup (§10.5.9). */
    onEnvActivity(callback: (chunk: InstallOutputChunk) => void): () => void;
    /** List declared deps paired with installed versions (uv projects only). */
    listPackages(): Promise<ProjectPackage[]>;
    /** Add packages to the project (`uv add <specs>`). */
    addPackage(specs: string[]): Promise<EnvironmentInstallResult>;
    /** Remove packages from the project (`uv remove <names>`). */
    removePackage(names: string[]): Promise<EnvironmentInstallResult>;
    /** Upgrade packages within their declared constraints (`uv lock --upgrade-package` + sync). */
    upgradePackage(names: string[]): Promise<EnvironmentInstallResult>;
    /** Active kernel's environment metadata, or null when no kernel is active. */
    activeInfo(): Promise<ActiveEnvironmentInfo | null>;
    /**
     * Run `pdv.install("<module>")` in the kernel (§10.5.12). The code
     * string is built in main and the run streams to the console via
     * executeBegin/executeOutput/executeFinish pushes.
     */
    installModule(kernelId: string, moduleName: string): Promise<void>;
    /** List discovered Julia runtimes with PDVKernel/IJulia status (§10.7.1). */
    listJulia(): Promise<JuliaRuntimeInfo[]>;
    /** Re-probe a single Julia executable, bypassing the discovery cache. */
    checkJulia(juliaPath: string): Promise<JuliaRuntimeInfo | null>;
    /**
     * Install PDVKernel + IJulia into a Julia runtime's default environment
     * (§10.7.4). Streams Pkg output via `onInstallOutput`.
     */
    installJulia(juliaPath: string): Promise<EnvironmentInstallResult>;
    /** Is the user's juliaup installed, and where (§10.7.5)? */
    juliaupStatus(): Promise<JuliaupStatus>;
    /**
     * Installed juliaup channels, filesystem-only (§10.7.1) — instant.
     * Feeds the New Julia Project dialog's version dropdown.
     */
    juliaupChannels(): Promise<JuliaupChannel[]>;
    /**
     * Acquire a Julia version (`juliaup add <channel>`, §10.7.5). Streams
     * ANSI-stripped output via `onInstallOutput`.
     */
    juliaupAdd(channel: string): Promise<EnvironmentInstallResult>;
    /**
     * Bootstrap juliaup via the official installer script (§10.7.5), which
     * also installs a default Julia. Streams output via `onInstallOutput`.
     */
    installJuliaup(): Promise<EnvironmentInstallResult>;
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
    createEmpty(request: {
      id: string;
      name: string;
      version: string;
      description?: string;
      language?: "python" | "julia";
    }): Promise<{
      success: boolean;
      alias?: string;
      status?: "created" | "conflict" | "error";
      suggestedAlias?: string;
      error?: string;
    }>;
    updateMetadata(request: {
      alias: string;
      name?: string;
      version?: string;
      description?: string;
    }): Promise<{
      success: boolean;
      alias?: string;
      name?: string;
      version?: string;
      description?: string;
      error?: string;
    }>;
    exportFromProject(request: {
      alias: string;
      overwrite?: boolean;
    }): Promise<{
      success: boolean;
      status?: "exported" | "cancelled" | "not_saved" | "error";
      destination?: string;
      error?: string;
    }>;
  };
  project: {
    save(saveDir: string, codeCells: unknown, projectName?: string): Promise<ProjectSaveResult>;
    load(saveDir: string, options?: { restoreFromAutosave?: boolean }): Promise<ProjectLoadResult>;
    new: () => Promise<boolean>;
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
  mcp: {
    /** Fetch the current MCP server status for the Settings → Agents pane. */
    getStatus(): Promise<McpStatus>;
    /**
     * Subscribe to MCP client connection-status push notifications. Fires
     * whenever the count of connected client sessions changes.
     */
    onClientStatus(
      callback: (status: McpClientStatusPayload) => void,
    ): () => void;
  };
  window: {
    /** Sync the BrowserWindow's native background to the active theme so
     *  live-resize gestures don't flash the OS-default white. */
    setBackgroundColor(color: string): Promise<void>;
  };
  autosave: {
    run(codeCells: unknown): Promise<{ saved: boolean }>;
    clear(dir?: string): Promise<void>;
    check(dir: string): Promise<{
      exists: boolean;
      timestamp?: string;
      language?: 'python' | 'julia';
    }>;
    scanWorkingDirs(): Promise<{
      dir: string;
      timestamp: string;
      language?: 'python' | 'julia';
      envMode?: 'uv' | 'pkg';
    }[]>;
    recoverUnsaved(orphanDir: string): Promise<{
      codeCells: unknown;
      projectName: string | null;
      missingFiles?: string[];
    }>;
    deleteOrphan(orphanDir: string): Promise<void>;
    onTrigger(callback: () => void): () => void;
    onInFlightChange(callback: (inFlight: boolean) => void): () => void;
  };
  /**
   * MCP cell-tool round-trip (ARCHITECTURE.md §15.8). The main process pushes
   * `cells.onRequest` and reads the renderer's reply via `cells.respond`;
   * `cells.onWrite` is one-way main → renderer.
   */
  cells: {
    onRequest(callback: (req: CellsRequestPush) => void): () => void;
    onWrite(callback: (write: CellWritePush) => void): () => void;
    respond(response: CellsResponse): Promise<void>;
  };
  about: {
    getVersion(): Promise<string>;
    openRepoPage(): Promise<void>;
    openIssuesPage(): Promise<void>;
    openDocsPage(): Promise<void>;
  };
  updater: {
    checkForUpdates(): Promise<void>;
    downloadUpdate(): Promise<void>;
    installUpdate(): Promise<void>;
    openReleasesPage(): Promise<void>;
    getStatus(): Promise<UpdateStatus | null>;
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
  /** Constant facts about the host system, injected at preload time. */
  system: {
    /** Node.js platform identifier of the main process. */
    platform: NodeJS.Platform;
    /** CPython minor versions offered by the New Project dialog, oldest first. */
    supportedPythonVersions: readonly string[];
    /** Julia minors offered by the New Julia Project dialog, oldest first. */
    supportedJuliaVersions: readonly string[];
    /** Fallback preselected Julia version when no juliaup default applies. */
    defaultJuliaVersion: string;
    /** Version preselected in the New Project dialog (e.g. `"3.13"`). */
    defaultPythonVersion: string;
  };
  /** External-app launchers driven by the action bar. */
  launchers: {
    /** Launch the configured AI agent in a terminal pointed at PDV's MCP server. */
    openAgent(): Promise<{ success: boolean; error?: string }>;
    /** Open the active kernel's working directory in the configured editor/IDE. */
    openWorkingDir(): Promise<{ success: boolean; error?: string }>;
    /** Check whether a launcher is installed (no launch), to gate Settings Save. */
    checkAvailability(check: LauncherCheck): Promise<boolean>;
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
    /**
     * Mark the main window's document as edited or clean. On macOS this
     * toggles the dot inside the red close traffic-light. No-op on other
     * platforms.
     */
    setDocumentEdited(edited: boolean): Promise<void>;
  };
}

declare global {
  interface Window {
    pdv: PDVApi;
  }
}

export {};
