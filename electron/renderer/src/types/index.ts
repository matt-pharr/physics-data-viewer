/**
 * index.ts — renderer-local type barrel.
 *
 * Re-exports shared preload API types from `types/pdv.d.ts` and defines
 * renderer-only view-model types used by components.
 */

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

/** Re-export core preload API contract types for renderer imports. */
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

/** One execution-history entry rendered in the Console panel. */
export interface LogEntry {
  id: string;
  timestamp: number;
  code: string;
  stdout?: string;
  stderr?: string;
  result?: unknown;
  error?: string;
  duration?: number;
  images?: Array<{ mime: string; data: string }>;
}

/** A persisted/active code-cell tab in the editor pane. */
export interface CellTab {
  id: number;
  code: string;
  name?: string;
}

/** Tree node shape enriched with UI state used by the Tree component. */
export interface TreeNodeData extends NodeDescriptor {
  hasChildren: boolean;
  parentPath: string | null;
  params?: ScriptParameter[] | undefined;
  children?: TreeNodeData[];
  isExpanded?: boolean;
  isLoading?: boolean;
}
