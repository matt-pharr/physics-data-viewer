// IPC channel names
export const IPC = {
  kernels: {
    list: 'kernels:list',
    start: 'kernels:start',
    stop: 'kernels:stop',
    execute: 'kernels:execute',
    interrupt: 'kernels:interrupt',
    restart:  'kernels:restart',
    complete: 'kernels: complete',
    inspect: 'kernels:inspect',
  },
  tree: {
    list: 'tree:list',
    get: 'tree:get',
    save: 'tree:save',
  },
  files: {
    read: 'files:read',
    write: 'files:write',
  },
  config: {
    get: 'config:get',
    set: 'config:set',
  },
} as const;

// Types
export interface KernelExecuteRequest {
  code: string;
  capture?: boolean;
  cwd?: string;
  files?: Array<{ path: string; content:  string | Buffer }>;
}

export interface KernelExecuteResult {
  stdout?:  string;
  stderr?: string;
  result?: unknown;
  images?: Array<{ mime: string; data: string }>; // base64 encoded
  rich?: unknown;
  error?: string;
  duration?: number;
}

export interface TreeNode {
  id: string;
  key: string;
  path: string;
  type: string;
  preview?: string;
  hasChildren:  boolean;
  sizeBytes?: number;
  shape?: number[];
  dtype?: string;
  loaderHint?: string;
  actions?:  string[];
}

export interface Config {
  kernelSpec:  string | null;
  plotMode: 'native' | 'capture';
  cwd: string;
  trusted: boolean;
}