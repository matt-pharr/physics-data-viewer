/**
 * index.ts — renderer-local type barrel.
 *
 * Re-exports shared preload API types from `types/pdv.d.ts` and defines
 * renderer-only view-model types used by components.
 */

import type {
  ActiveEnvironmentInfo,
  AgentLauncherConfig,
  Config,
  EditorLauncherConfig,
  EnvironmentInfo,
  EnvironmentInstallResult,
  InstallOutputChunk,
  JuliaRuntimeInfo,
  JuliaupChannel,
  JuliaupStatus,
  JuliaVersionLoadCheck,
  LauncherCheck,
  KernelExecutionError,
  KernelExecutionOrigin,
  KernelExecuteResult,
  KernelRestartResult,
  KernelSpec,
  KernelUvContext,
  ProjectPackage,
  ImportedModuleDescriptor,
  LayoutActionRef,
  LayoutContainer,
  LayoutInputRef,
  LayoutNode,
  AppMenuTopLevel,
  McpStatus,
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
  RecentProjectEntry,
  ScriptParameter,
  TerminalLauncherConfig,
  TerminalPreset,
  ScriptRunResult,
  Theme,
  RemoteConnectResult,
  RemoteHostAlias,
  RemotePhase,
  RemoteStatus,
  UpdateStatus,
  WindowChromeInfo,
} from './pdv';

/** Re-export core preload API contract types for renderer imports. */
export type {
  ActiveEnvironmentInfo,
  AgentLauncherConfig,
  Config,
  EditorLauncherConfig,
  EnvironmentInfo,
  EnvironmentInstallResult,
  InstallOutputChunk,
  JuliaRuntimeInfo,
  JuliaupChannel,
  JuliaupStatus,
  JuliaVersionLoadCheck,
  KernelExecutionError,
  KernelExecutionOrigin,
  KernelExecuteResult,
  KernelRestartResult,
  KernelSpec,
  KernelUvContext,
  ProjectPackage,
  ImportedModuleDescriptor,
  LauncherCheck,
  LayoutActionRef,
  LayoutContainer,
  LayoutInputRef,
  LayoutNode,
  AppMenuTopLevel,
  McpStatus,
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
  RecentProjectEntry,
  ScriptParameter,
  ScriptRunResult,
  TerminalLauncherConfig,
  TerminalPreset,
  Theme,
  RemoteConnectResult,
  RemoteHostAlias,
  RemotePhase,
  RemoteStatus,
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
  /**
   * Count of images dropped from this entry to bound renderer memory (base64
   * plots are large; only the newest entries keep theirs). Rendered as an
   * "image expired" note.
   */
  imagesDropped?: number;
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
    | 'updated_at'
    | 'module_id'
    | 'module_name'
    | 'module_version'
    | 'module_description'
    | 'module_language'
    | 'parent_is_opaque'
    | 'is_coord'
  > {
  type: NodeDescriptor['type'] | 'root';
  parentPath: string | null;
  hasChildren: boolean;
  pythonType?: string;
  hasHandler?: boolean;
  updatedAt?: string;
  moduleId?: string;
  moduleName?: string;
  moduleVersion?: string;
  moduleDescription?: string;
  moduleLanguage?: 'python' | 'julia';
  /** True when the parent container can't be addressed by key from the
   *  tree-mutation handlers (list/tuple/Dataset). Drives suppression of
   *  rename / move / duplicate / delete on this row. See the wire field
   *  ``parent_is_opaque`` on ``NodeDescriptor`` for the full contract. */
  parentIsOpaque?: boolean;
  /** True when this row is a coordinate of a dataset parent — renders
   *  with a `coord` chip marker and muted styling. Wire field
   *  ``is_coord`` on ``NodeDescriptor``. */
  isCoord?: boolean;
  children?: TreeNodeData[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

/** Describes a tree change pushed from the kernel. */
export interface TreeChangeInfo {
  changed_paths: string[];
  /**
   * Granularity of the change.
   *
   * - ``added`` / ``removed`` / ``updated``: precise per-path notifications
   *   from the root tree.
   * - ``batch``: multiple precise paths coalesced under one debounce window.
   * - ``unknown``: a non-root ``PDVTree`` mutated, or a 1 Hz poll detected
   *   drift; ``changed_paths`` is empty and the consumer should do a full
   *   refresh.
   */
  change_type: 'added' | 'removed' | 'updated' | 'batch' | 'unknown';
}
