/**
 * tree.ts — Renderer-side tree data access service.
 *
 * Thin adapter over `window.pdv.tree.list` that converts wire-format
 * descriptors into renderer `TreeNodeData` objects. Deliberately uncached:
 * every call returns freshly fetched, freshly built objects, so callers can
 * tag UI state (`isExpanded`, `children`) onto the results without aliasing
 * data seen by other callers, and no consumer ever renders stale structure.
 * Listing goes through the kernel's dedicated read-only query thread
 * (pdv.query_server), so fetches stay fast even mid-execution.
 */

import type { NodeDescriptor } from '../types/pdv';
import type { TreeNodeData } from '../types';

/** Tree API adapter converting wire descriptors to renderer node data. */
class TreeService {
  private async listAndEnrich(kernelId: string, path: string): Promise<TreeNodeData[]> {
    const nodes = await window.pdv.tree.list(kernelId, path);
    return nodes.map(this.enrichNode);
  }

  /** Fetch root-level tree nodes for the active kernel. */
  async getRootNodes(kernelId: string | null): Promise<TreeNodeData[]> {
    if (!kernelId) return [];
    return this.listAndEnrich(kernelId, '');
  }

  /** Fetch children for one expanded parent node. */
  async getChildren(node: TreeNodeData, kernelId: string | null): Promise<TreeNodeData[]> {
    if (!kernelId) return [];
    if (!node.hasChildren) {
      return [];
    }
    return this.listAndEnrich(kernelId, node.path);
  }

  /**
   * Fetch children for an arbitrary tree path string.
   *
   * Use this when the caller has a path but no `TreeNodeData` (e.g.
   * Monaco autocomplete, module-window dropdown population).
   */
  async listByPath(kernelId: string | null, path: string): Promise<TreeNodeData[]> {
    if (!kernelId) return [];
    return this.listAndEnrich(kernelId, path);
  }

  /**
   * Convert a wire-format {@link NodeDescriptor} (snake_case) into the
   * renderer-facing {@link TreeNodeData} shape (camelCase) and tag it with
   * default UI state. All wire fields are mapped — adding a new field to
   * `NodeDescriptor` requires updating both this mapper and the
   * `TreeNodeData` declaration in `types/index.ts`.
   */
  private enrichNode = (node: NodeDescriptor): TreeNodeData => {
    const {
      parent_path,
      has_children,
      python_type,
      has_handler,
      updated_at,
      module_id,
      module_name,
      module_version,
      module_description,
      module_language,
      parent_is_opaque,
      ...rest
    } = node;
    return {
      ...rest,
      parentPath: parent_path ?? null,
      hasChildren: Boolean(has_children),
      pythonType: python_type,
      hasHandler: has_handler,
      updatedAt: updated_at,
      moduleId: module_id,
      moduleName: module_name,
      moduleVersion: module_version,
      moduleDescription: module_description,
      moduleLanguage: module_language,
      parentIsOpaque: Boolean(parent_is_opaque),
      isExpanded: false,
      isLoading: false,
    };
  };
}

/** Singleton tree service used by tree-related renderer components. */
export const treeService = new TreeService();
/** Re-export local tree node shape for component imports. */
export type { TreeNodeData };
