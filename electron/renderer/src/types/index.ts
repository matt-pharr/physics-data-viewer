import type {
  Config,
  KernelExecuteResult,
  MenuActionPayload,
  NamespaceQueryOptions,
  NamespaceVariable,
  NodeDescriptor,
  ScriptParameter,
  Theme,
} from './pdv';

export type {
  Config,
  KernelExecuteResult,
  MenuActionPayload,
  NamespaceQueryOptions,
  NamespaceVariable,
  NodeDescriptor,
  ScriptParameter,
  Theme,
};

export interface LogEntry {
  id: string;
  timestamp: number;
  code: string;
  stdout?: string;
  stderr?: string;
  result?: unknown;
  error?: string;
  duration?: number;
}

export interface CommandTab {
  id: number;
  code: string;
}

export interface TreeNodeData extends NodeDescriptor {
  hasChildren: boolean;
  parentPath: string | null;
  params?: ScriptParameter[] | undefined;
  children?: TreeNodeData[];
  isExpanded?: boolean;
  isLoading?: boolean;
}
