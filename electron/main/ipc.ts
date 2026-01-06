/**
 * IPC Channel Names and Type Definitions
 * 
 * This file is the single source of truth for all IPC communication
 * between the main process and renderer. 
 */

// ============================================================================
// IPC Channel Names
// ============================================================================

export const IPC = {
  kernels: {
    list: 'kernels:list',
    start: 'kernels:start',
    stop: 'kernels:stop',
    execute: 'kernels:execute',
    interrupt: 'kernels:interrupt',
    restart: 'kernels:restart',
    complete: 'kernels:complete',
    inspect: 'kernels:inspect',
    validate: 'kernels:validate',
  },
  tree: {
    list: 'tree:list',
    get: 'tree:get',
    save: 'tree:save',
    create_script: 'tree:create_script',
  },
  script: {
    run: 'script:run',
    edit: 'script:edit',
    reload: 'script:reload',
    get_params: 'script:get_params',
  },
  files: {
    read: 'files:read',
    write: 'files:write',
    pickExecutable: 'files:pickExecutable',
    watch: 'files:watch',
    unwatch: 'files:unwatch',
  },
  namespace: {
    query: 'namespace:query',
  },
  config: {
    get: 'config:get',
    set: 'config:set',
  },
} as const;

// ============================================================================
// Kernel Types
// ============================================================================

/** Information about an available kernel spec */
export interface KernelSpec {
  name: string;
  displayName: string;
  language: 'python' | 'julia';
  argv?: string[];
  env?: Record<string, string>;
}

/** Information about a running kernel */
export interface KernelInfo {
  id: string;
  name: string;
  language: 'python' | 'julia';
  status: 'idle' | 'busy' | 'starting' | 'error' | 'dead';
}

/** Request to execute code in a kernel */
export interface KernelExecuteRequest {
  /** The code to execute */
  code: string;
  /** If true, capture plot output instead of showing native windows */
  capture?: boolean;
  /** Working directory for execution */
  cwd?: string;
  /** Files to write before execution (for "run file" functionality) */
  files?: Array<{ path: string; content: string }>;
}

/** Result of code execution */
export interface KernelExecuteResult {
  /** Standard output */
  stdout?: string;
  /** Standard error */
  stderr?: string;
  /** Return value of the last expression (if any) */
  result?: unknown;
  /** Captured images (when capture mode is enabled) */
  images?: Array<{ mime: string; data: string }>;
  /** Rich output (HTML, LaTeX, etc.) */
  rich?: Record<string, string>;
  /** Error message if execution failed */
  error?: string;
  /** Execution duration in milliseconds */
  duration?: number;
}

/** Completion result */
export interface KernelCompleteResult {
  matches: string[];
  cursor_start: number;
  cursor_end: number;
  metadata?: Record<string, unknown>;
}

/** Inspection result */
export interface KernelInspectResult {
  found: boolean;
  data?: Record<string, string>;
}

// ============================================================================
// Namespace Types
// ============================================================================

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
  size?: number;
  preview?: string;
  min?: number;
  max?: number;
  mean?: number;
  length?: number;
  columns?: string[];
  keys?: string[];
  error?: string;
}

// ============================================================================
// Tree Types
// ============================================================================

/** A node in the data tree */
export interface TreeNode {
  /** Unique identifier for this node */
  id: string;
  /** Display key/name */
  key: string;
  /** Full path in the tree (e.g., "root.data.array1") */
  path: string;
  /** Type of the node */
  type: TreeNodeType;
  /** Short preview of the value */
  preview?: string;
  /** Whether this node has children */
  hasChildren: boolean;
  /** Size in bytes (for data nodes) */
  sizeBytes?: number;
  /** Shape (for array-like data) */
  shape?: number[];
  /** Data type (for typed arrays) */
  dtype?: string;
  /** Hint for which loader to use */
  loaderHint?: string;
  /** Available actions for this node */
  actions?: string[];
  /** Whether this node is expandable */
  expandable?: boolean;
  /** Whether this node's content is lazily loaded */
  lazy?: boolean;
  /** Optional language for script nodes */
  language?: string;
  /** Backing file path on disk */
  _file_path?: string;
  /** Last modified timestamp */
  _modified?: string;
}

/** Supported node types */
export type TreeNodeType =
  | 'root'
  | 'folder'
  | 'file'
  | 'script'
  | 'hdf5'
  | 'zarr'
  | 'parquet'
  | 'npy'
  | 'config'
  | 'arrow'
  | 'group'        // HDF5 group, etc.
  | 'dataset'      // HDF5 dataset, etc.
  | 'ndarray'
  | 'dataframe'
  | 'series'
  | 'dict'
  | 'list'
  | 'tuple'
  | 'set'
  | 'string'
  | 'number'
  | 'boolean'
  | 'none'
  | 'image'
  | 'text'
  | 'json'
  | 'pickle'
  | 'jlso'
  | 'unknown';

/** Options for fetching tree node content */
export interface TreeGetOptions {
  /** Start index for slicing (arrays) */
  start?: number;
  /** End index for slicing (arrays) */
  end?: number;
  /** Columns to fetch (dataframes) */
  columns?: string[];
  /** Whether to trust unsafe serialization (pickle, JLSO) */
  trusted?: boolean;
}

// ============================================================================
// File Types
// ============================================================================

/** Options for reading files */
export interface FileReadOptions {
  /** Start byte offset */
  start?: number;
  /** End byte offset */
  end?: number;
  /** Encoding (default: 'utf-8', use 'binary' for ArrayBuffer) */
  encoding?: 'utf-8' | 'binary';
}

/** Result of file read */
export interface FileReadResult {
  content: string | ArrayBuffer;
  size: number;
  mtime: number;
}

// ============================================================================
// Script Types
// ============================================================================

export interface ScriptRunRequest {
  scriptPath: string; // Tree path (e.g., "scripts.analysis.fit_model")
  params?: Record<string, unknown>;
}

export interface ScriptRunResult {
  success: boolean;
  result?: unknown;
  error?: string;
  duration?: number;
  stdout?: string;
  stderr?: string;
}

export interface ScriptParameter {
  name: string;
  type: string;
  default?: unknown;
  required?: boolean;
  description?: string;
}

// ============================================================================
// Config Types
// ============================================================================

/** Application configuration */
export interface Config {
  /** Selected kernel spec name */
  kernelSpec: string | null;
  /** Plot mode: native windows or capture */
  plotMode: 'native' | 'capture';
  /** Current working directory */
  cwd: string;
  /** Whether to trust unsafe deserialization */
  trusted: boolean;
  /** Recently opened projects */
  recentProjects?: string[];
  /** Custom kernel commands */
  customKernels?: KernelSpec[];
  /** Custom python executable path */
  pythonPath?: string;
  /** Custom julia executable path */
  juliaPath?: string;
  /** External editor commands */
  editors?: {
    python?: string;
    julia?: string;
    default?: string;
  };
  /** Project root for tree scanning */
  projectRoot?: string;
}

// ============================================================================
// API Types (for preload)
// ============================================================================

/** The API exposed to the renderer via window.pdv */
export interface PDVApi {
  kernels: {
    list: () => Promise<KernelInfo[]>;
    start: (spec?: Partial<KernelSpec>) => Promise<KernelInfo>;
    stop: (id: string) => Promise<boolean>;
    execute: (id: string, request: KernelExecuteRequest) => Promise<KernelExecuteResult>;
    interrupt: (id: string) => Promise<boolean>;
    restart: (id: string) => Promise<KernelInfo>;
    complete: (id: string, code: string, cursorPos: number) => Promise<KernelCompleteResult>;
    inspect: (id: string, code: string, cursorPos: number) => Promise<KernelInspectResult>;
    validate: (path: string, language: 'python' | 'julia') => Promise<{ valid: boolean; error?: string }>;
  };
  namespace: {
    query: (
      kernelId: string,
      options?: NamespaceQueryOptions,
    ) => Promise<{ variables?: NamespaceVariable[]; error?: string }>;
  };
  tree: {
    list: (kernelId: string, path?: string) => Promise<TreeNode[]>;
    get: (id: string, options?: TreeGetOptions) => Promise<unknown>;
    save: (id: string, value: unknown) => Promise<boolean>;
    createScript: (
      kernelId: string,
      targetPath: string,
      scriptName: string,
    ) => Promise<{ success: boolean; error?: string; node?: TreeNode }>;
  };
  files: {
    read: (path: string, options?: FileReadOptions) => Promise<FileReadResult | null>;
    write: (path: string, content: string | ArrayBuffer) => Promise<boolean>;
    pickExecutable: () => Promise<string | null>;
  };
  config: {
    get: () => Promise<Config>;
    set: (config: Partial<Config>) => Promise<boolean>;
  };
  script: {
    run: (kernelId: string, request: ScriptRunRequest) => Promise<ScriptRunResult>;
    edit: (scriptPath: string) => Promise<{ success: boolean; error?: string }>;
    reload: (scriptPath: string) => Promise<{ success: boolean; error?: string }>;
    getParams: (scriptPath: string) => Promise<{ success: boolean; params?: ScriptParameter[]; error?: string }>;
  };
}
