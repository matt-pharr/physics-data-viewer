export interface ScriptParameter {
  name: string;
  type: string;
  default: unknown;
  required: boolean;
}

export interface NodeDescriptor {
  id: string;
  path: string;
  key: string;
  parent_path: string | null;
  type: string;
  has_children: boolean;
  lazy: boolean;
  preview?: string;
  language?: string | null;
  params?: ScriptParameter[] | undefined;
}

export interface KernelInfo {
  id: string;
  name: string;
  language: "python" | "julia";
  status: "idle" | "busy" | "starting" | "error" | "dead";
}

export interface KernelSpec {
  name?: string;
  displayName?: string;
  language?: "python" | "julia";
  argv?: string[];
  env?: Record<string, string>;
}

export interface KernelExecuteRequest {
  code: string;
  silent?: boolean;
  /** Caller-supplied ID to correlate streamed output chunks with this execution. */
  executionId?: string;
}

export interface ExecuteOutputChunk {
  executionId: string;
  type: "stdout" | "stderr" | "image" | "result";
  text?: string;
  image?: { mime: string; data: string };
  result?: unknown;
}

export interface KernelExecuteResult {
  stdout?: string;
  stderr?: string;
  result?: unknown;
  error?: string;
  duration?: number;
  /** Inline images captured from display_data iopub messages (Agg fallback). */
  images?: Array<{ mime: string; data: string }>;
}

export interface NamespaceQueryOptions {
  includePrivate?: boolean;
  includeModules?: boolean;
  includeCallables?: boolean;
}

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

export interface Theme {
  name: string;
  colors: Record<string, string>;
}

export interface CodeCellData {
  tabs: Array<{ id: number; code: string; name?: string }>;
  activeTabId: number;
}

export interface MenuActionPayload {
  action: "project:open" | "project:openRecent" | "project:save" | "project:saveAs";
  path?: string;
}

export interface Config {
  kernelSpec?: string | null;
  cwd?: string;
  trusted?: boolean;
  recentProjects?: string[];
  customKernels?: unknown[];
  pythonPath?: string;
  juliaPath?: string;
  editors?: Record<string, string>;
  projectRoot?: string;
  treeRoot?: string;
  showPrivateVariables?: boolean;
  showModuleVariables?: boolean;
  showCallableVariables?: boolean;
  theme?: "light" | "dark";
  /** External editor command for Python scripts. Uses `{}` as file-path placeholder. */
  pythonEditorCmd?: string;
  /** External editor command for Julia scripts. Uses `{}` as file-path placeholder. */
  juliaEditorCmd?: string;
  /** File-manager command to reveal a file/folder. Uses `{}` as placeholder. */
  fileManagerCmd?: string;
  settings?: {
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
