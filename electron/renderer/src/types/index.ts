/**
 * index.ts — renderer-local type barrel.
 *
 * Re-exports shared preload API types from `types/pdv.d.ts` and defines
 * renderer-only view-model types used by components.
 */

import type {
  Config,
  EnvironmentInfo,
  InstallOutputChunk,
  KernelExecutionError,
  KernelExecutionOrigin,
  KernelExecuteResult,
  KernelSpec,
  ImportedModuleDescriptor,
  LayoutActionRef,
  LayoutContainer,
  LayoutInputRef,
  LayoutNode,
  AppMenuTopLevel,
  MenuActionPayload,
  ModuleDescriptor,
  ModuleGuiLayout,
  ModuleImportResult,
  ModuleInstallResult,
  ModuleWindowContext,
  ModuleWindowOpenRequest,
  ModuleWindowOpenResult,
  NamespaceAccessSegment,
  NamespaceInspectorNode,
  NamespaceInspectResult,
  NamespaceInspectTarget,
  NamespaceQueryOptions,
  NamespaceVariable,
  NodeDescriptor,
  ProjectLoadResult,
  ProjectSaveResult,
  ScriptParameter,
  ScriptRunResult,
  Theme,
  UpdateStatus,
  WindowChromeInfo,
} from './pdv';

/** Re-export core preload API contract types for renderer imports. */
export type {
  Config,
  EnvironmentInfo,
  InstallOutputChunk,
  KernelExecutionError,
  KernelExecutionOrigin,
  KernelExecuteResult,
  KernelSpec,
  ImportedModuleDescriptor,
  LayoutActionRef,
  LayoutContainer,
  LayoutInputRef,
  LayoutNode,
  AppMenuTopLevel,
  MenuActionPayload,
  ModuleDescriptor,
  ModuleGuiLayout,
  ModuleImportResult,
  ModuleInstallResult,
  ModuleWindowContext,
  ModuleWindowOpenRequest,
  ModuleWindowOpenResult,
  NamespaceAccessSegment,
  NamespaceInspectorNode,
  NamespaceInspectResult,
  NamespaceInspectTarget,
  NamespaceQueryOptions,
  NamespaceVariable,
  ProjectLoadResult,
  ProjectSaveResult,
  ScriptParameter,
  ScriptRunResult,
  Theme,
  UpdateStatus,
  WindowChromeInfo,
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
  errorDetails?: KernelExecutionError;
  origin?: KernelExecutionOrigin;
  duration?: number;
  images?: Array<{ mime: string; data: string }>;
}

/** A persisted/active code-cell tab in the editor pane. */
export interface CellTab {
  id: number;
  code: string;
  name?: string;
}

/** An open markdown note tab in the Write pane. */
export interface NoteTab {
  /** Tree path of the markdown node (unique identifier). */
  id: string;
  /** Current editor content. */
  content: string;
  /** Last-saved content (for dirty detection). */
  savedContent: string;
  /** Display name for the tab. */
  name: string;
}

/**
 * Tree node shape enriched with UI state used by the Tree component.
 *
 * The wire-canonical {@link NodeDescriptor} uses snake_case field names
 * (matching the kernel's JSON output). The renderer convention is camelCase,
 * so this view-model omits the snake_case wire fields and re-exposes the
 * same data under camelCase keys via {@link enrichNode}.
 *
 * Widens `type` from `NodeKindValue` to also accept the synthetic `'root'`
 * value used by the Tree panel for the always-visible root container row;
 * all real wire nodes still satisfy `NodeKindValue`.
 */
export interface TreeNodeData
  extends Omit<
    NodeDescriptor,
    | 'type'
    | 'parent_path'
    | 'has_children'
    | 'python_type'
    | 'has_handler'
    | 'created_at'
    | 'updated_at'
    | 'module_id'
    | 'module_name'
    | 'module_version'
    | 'module_description'
    | 'module_language'
  > {
  type: NodeDescriptor['type'] | 'root';
  parentPath: string | null;
  hasChildren: boolean;
  pythonType?: string;
  hasHandler?: boolean;
  createdAt?: string;
  updatedAt?: string;
  moduleId?: string;
  moduleName?: string;
  moduleVersion?: string;
  moduleDescription?: string;
  moduleLanguage?: 'python' | 'julia';
  children?: TreeNodeData[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

/** Describes a tree change pushed from the kernel. */
export interface TreeChangeInfo {
  changed_paths: string[];
  change_type: 'added' | 'removed' | 'updated' | 'batch';
}
