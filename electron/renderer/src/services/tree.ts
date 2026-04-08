/**
 * tree.ts — Renderer-side tree data access service.
 *
 * Wraps `window.pdv.tree.*` calls with a small in-memory cache keyed by
 * kernel-id + node path so tree expansion remains responsive.
 */

import type { NodeDescriptor } from '../types/pdv';
import type { TreeNodeData } from '../types';

/** Tree API adapter with per-kernel/path caching. */
class TreeService {
  private cache: Map<string, TreeNodeData[]> = new Map();

  private async listAndEnrich(kernelId: string, path: string): Promise<TreeNodeData[]> {
    const nodes = await window.pdv.tree.list(kernelId, path);
    return nodes.map(this.enrichNode);
  }

  /** Build a stable cache key scoped to kernel and tree path. */
  private cacheKey(kernelId: string | null, path: string) {
    const safeKernel = kernelId ?? '__none__';
    return `${safeKernel}|${path}`;
  }

  /** Fetch and cache root-level tree nodes for the active kernel. */
  async getRootNodes(
    kernelId: string | null,
    options?: { force?: boolean }
  ): Promise<TreeNodeData[]> {
    if (!kernelId) return [];

    const key = this.cacheKey(kernelId, '');
    if (!options?.force) {
      const cached = this.cache.get(key);
      if (cached) {
        return cached;
      }
    }

    const enriched = await this.listAndEnrich(kernelId, '');
    this.cache.set(key, enriched);
    return enriched;
  }

  /** Fetch and cache children for one expanded parent node. */
  async getChildren(
    node: TreeNodeData,
    kernelId: string | null,
    options?: { force?: boolean }
  ): Promise<TreeNodeData[]> {
    if (!kernelId) return [];
    if (!node.hasChildren) {
      return [];
    }

    const key = this.cacheKey(kernelId, node.path);
    if (!options?.force) {
      const cached = this.cache.get(key);
      if (cached) {
        return cached;
      }
    }

    const enriched = await this.listAndEnrich(kernelId, node.path);
    this.cache.set(key, enriched);
    return enriched;
  }

  /** Invalidate the cache entry for a single path (leaves other entries intact). */
  invalidatePath(kernelId: string, path: string): void {
    const key = this.cacheKey(kernelId, path);
    this.cache.delete(key);
  }

  /** Clear all cache entries, or only entries for a specific kernel id. */
  clearCache(kernelId?: string | null): void {
    if (!kernelId) {
      this.cache.clear();
      return;
    }
    const safeKernel = kernelId ?? '__none__';
    const prefix = `${safeKernel}|`;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
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
      created_at,
      updated_at,
      module_id,
      module_name,
      module_version,
      ...rest
    } = node;
    return {
      ...rest,
      parentPath: parent_path ?? null,
      hasChildren: Boolean(has_children),
      pythonType: python_type,
      hasHandler: has_handler,
      createdAt: created_at,
      updatedAt: updated_at,
      moduleId: module_id,
      moduleName: module_name,
      moduleVersion: module_version,
      isExpanded: false,
      isLoading: false,
    };
  };
}

/** Singleton tree service used by tree-related renderer components. */
export const treeService = new TreeService();
/** Re-export local tree node shape for component imports. */
export type { TreeNodeData };
